import type { Dispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { AdapterError } from './core.js';
import { acquireSalesforceToken } from './token-source.js';

const dispatcher = {} as Dispatcher;
const tokenUrl = new URL('https://example.my.salesforce.com/services/oauth2/token');

describe('acquireSalesforceToken', () => {
  it('sends only the exact client-credentials form through the scoped dispatcher', async () => {
    const fetcher = vi.fn(async () => new Response('{"access_token":"opaque"}', { status: 200 }));
    await expect(acquireSalesforceToken(tokenUrl, dispatcher, 1_000, fetcher)).resolves.toBe('opaque');
    expect(fetcher).toHaveBeenCalledWith(
      tokenUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        dispatcher,
      }),
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.headers).not.toHaveProperty('authorization');
  });

  it.each([
    new Response('{}', { status: 401 }),
    new Response('{}', { status: 500 }),
    new Response('{}', { status: 200 }),
    new Response('x'.repeat(32_769), { status: 200 }),
  ])('sanitizes failed or malformed token responses', async (response) => {
    await expect(
      acquireSalesforceToken(
        tokenUrl,
        dispatcher,
        1_000,
        vi.fn(async () => response),
      ),
    ).rejects.toEqual(new AdapterError('AUTH_UNAVAILABLE'));
  });

  it('sanitizes transport failure', async () => {
    await expect(
      acquireSalesforceToken(
        tokenUrl,
        dispatcher,
        1_000,
        vi.fn(async () => {
          throw new Error('secret-bearing transport detail');
        }),
      ),
    ).rejects.toEqual(new AdapterError('AUTH_UNAVAILABLE'));
  });
});
