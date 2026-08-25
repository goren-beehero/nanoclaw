import http from 'node:http';
import { ProxyAgent } from 'undici';

import { auditLine } from './audit.js';
import { AdapterError, SalesforceAdapter, TokenManager } from './core.js';
import { acquireSalesforceToken } from './token-source.js';

if (process.env.ONECLI_API_KEY) throw new Error('ONECLI_API_KEY must not be present in the adapter runtime');

const salesforceOrigin = requiredOrigin('SALESFORCE_ORIGIN');
const tokenUrl = new URL('/services/oauth2/token', salesforceOrigin);
const proxyUrl = process.env.HTTPS_PROXY;
if (!proxyUrl) throw new Error('HTTPS_PROXY is required for OneCLI token injection');
const proxy = new ProxyAgent(proxyUrl);

const tokenManager = new TokenManager(
  () => acquireSalesforceToken(tokenUrl, proxy, integer('TOKEN_REQUEST_TIMEOUT_MS', 10_000, 1_000, 30_000)),
  integer('TOKEN_MAX_AGE_MS', 600_000, 60_000, 3_600_000),
);

const adapter = new SalesforceAdapter(
  {
    salesforceOrigin,
    apiVersion: process.env.SALESFORCE_API_VERSION || 'v65.0',
    maxResponseBytes: integer('MAX_RESPONSE_BYTES', 2_000_000, 10_000, 5_000_000),
    maxRows: integer('MAX_ROWS', 1_000, 1, 2_000),
    maxPages: integer('MAX_PAGES', 5, 1, 10),
    maxConcurrentRequests: integer('MAX_CONCURRENT_REQUESTS', 8, 1, 32),
    requestTimeoutMs: integer('REQUEST_TIMEOUT_MS', 15_000, 1_000, 30_000),
  },
  tokenManager,
);

const server = http.createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  if (request.method === 'GET' && request.url === '/live') return send(response, 200, { ok: true });
  if (request.method === 'GET' && request.url === '/ready') {
    const ready = await adapter.readiness();
    return send(response, ready ? 200 : 503, { ok: ready });
  }
  if (request.method === 'GET' && request.url === '/metrics') {
    return send(response, 200, { ok: true, metrics: adapter.metrics() });
  }
  const match = request.method === 'POST' ? /^\/v1\/tools\/([A-Za-z]+)$/.exec(request.url || '') : null;
  if (!match) return send(response, 404, { ok: false, error: 'FORBIDDEN_OPERATION' });
  const operation = match[1];
  const startedAt = Date.now();
  try {
    const input = await readJson(request, 32_768);
    const result = await adapter.execute(operation, input);
    audit(operation, 'ok', Date.now() - startedAt);
    return send(response, 200, { ok: true, result });
  } catch (error) {
    const code = error instanceof AdapterError ? error.code : 'UPSTREAM_UNAVAILABLE';
    audit(operation, code, Date.now() - startedAt);
    return send(response, code === 'INVALID_INPUT' || code === 'FORBIDDEN_OPERATION' ? 400 : 503, {
      ok: false,
      error: code,
    });
  }
});

server.requestTimeout = 25_000;
server.headersTimeout = 5_000;
server.listen(integer('PORT', 8080, 1024, 65_535), '0.0.0.0');

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new AdapterError('INVALID_INPUT');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AdapterError('INVALID_INPUT');
  }
}

function requiredOrigin(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash)
    throw new Error(`${name} must be an exact HTTPS origin`);
  return url.origin + '/';
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is invalid`);
  return value;
}

function audit(operation: string, outcome: string, durationMs: number): void {
  process.stdout.write(`${auditLine(operation, outcome, durationMs)}\n`);
}
