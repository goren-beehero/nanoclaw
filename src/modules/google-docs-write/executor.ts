import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { GOOGLE_DOCS_WRITER_IDENTIFIER, ONECLI_API_KEY, ONECLI_URL } from '../../config.js';

const REQUEST_TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

interface OneCLIContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
}

export interface GoogleDocsUpdateResult {
  documentId: string;
  replyCount: number;
}

export async function executeGoogleDocsBatchUpdate(
  documentId: string,
  requests: unknown[],
): Promise<GoogleDocsUpdateResult> {
  await onecli.ensureAgent({ name: 'Bobi Google Docs Writer', identifier: GOOGLE_DOCS_WRITER_IDENTIFIER });
  const config = (await onecli.getContainerConfig({
    agent: GOOGLE_DOCS_WRITER_IDENTIFIER,
  })) as OneCLIContainerConfig;
  if (!config.caCertificate) throw new Error('OneCLI did not return a CA certificate for the Google Docs writer');

  const rawProxy = config.env.HTTPS_PROXY || config.env.https_proxy || config.env.HTTP_PROXY || config.env.http_proxy;
  if (!rawProxy) throw new Error('OneCLI did not return a proxy for the Google Docs writer');

  const proxy = hostProxyUrl(rawProxy);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-google-docs-'));
  const caPath = path.join(tempDir, 'onecli-ca.pem');
  fs.writeFileSync(caPath, config.caCertificate, { mode: 0o600 });

  try {
    const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`;
    const response = await runCurl(
      [
        '--silent',
        '--show-error',
        '--request',
        'POST',
        '--proxy',
        proxy,
        '--cacert',
        caPath,
        '--header',
        'Content-Type: application/json',
        '--data-binary',
        '@-',
        '--max-time',
        String(REQUEST_TIMEOUT_SECONDS),
        '--write-out',
        '\n%{http_code}',
        url,
      ],
      JSON.stringify({ requests }),
    );

    const splitAt = response.lastIndexOf('\n');
    if (splitAt < 0) throw new Error('Google Docs returned an invalid HTTP response');
    const body = response.slice(0, splitAt);
    const status = Number(response.slice(splitAt + 1));
    const parsed = safeJson(body);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(googleApiError(parsed, status));
    }

    const result = parsed as { documentId?: unknown; replies?: unknown };
    return {
      documentId: typeof result.documentId === 'string' ? result.documentId : documentId,
      replyCount: Array.isArray(result.replies) ? result.replies.length : 0,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function hostProxyUrl(raw: string): string {
  const url = new URL(raw);
  if (url.hostname === 'host.docker.internal') {
    if (!ONECLI_URL) throw new Error('ONECLI_URL is required to resolve the host-side OneCLI proxy');
    url.hostname = new URL(ONECLI_URL).hostname;
  }
  return url.toString();
}

function runCurl(args: string[], body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        fail(new Error('Google Docs response exceeded the safety limit'));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        fail(new Error(`Google Docs request failed${detail ? `: ${detail}` : ''}`));
        return;
      }
      settled = true;
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(body);
  });
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body.slice(0, 500) };
  }
}

function googleApiError(value: unknown, status: number): string {
  const message =
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'message' in value.error &&
    typeof value.error.message === 'string'
      ? value.error.message
      : `HTTP ${status}`;
  return `Google Docs rejected the update: ${message}`;
}
