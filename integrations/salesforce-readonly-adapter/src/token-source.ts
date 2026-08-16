import type { Dispatcher } from 'undici';
import { fetch as undiciFetch } from 'undici';

import { AdapterError } from './core.js';

type TokenFetch = (
  url: URL,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    dispatcher: Dispatcher;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export async function acquireSalesforceToken(
  tokenUrl: URL,
  dispatcher: Dispatcher,
  timeoutMs: number,
  fetcher: TokenFetch = undiciFetch,
): Promise<string> {
  let response: Awaited<ReturnType<TokenFetch>>;
  try {
    response = await fetcher(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AdapterError('AUTH_UNAVAILABLE');
  }
  if (!response.ok) throw new AdapterError('AUTH_UNAVAILABLE');

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 32_768) throw new AdapterError('AUTH_UNAVAILABLE');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 32_768) throw new AdapterError('AUTH_UNAVAILABLE');
  try {
    const payload = JSON.parse(text) as { access_token?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new AdapterError('AUTH_UNAVAILABLE');
    }
    return payload.access_token;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('AUTH_UNAVAILABLE');
  }
}
