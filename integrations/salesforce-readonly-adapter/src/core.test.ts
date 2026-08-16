import { describe, expect, it, vi } from 'vitest';
import { AdapterError, SalesforceAdapter, TokenManager } from './core.js';

describe('TokenManager', () => {
  it('coalesces concurrent cold-start token exchanges', async () => {
    const acquire = vi.fn(async () => 'token');
    const manager = new TokenManager(acquire, 60_000);
    const values = await Promise.all(Array.from({ length: 20 }, () => manager.get()));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(new Set(values.map((value) => value.generation))).toEqual(new Set([1]));
  });

  it('invalidates only the failed current generation', async () => {
    const acquire = vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    const manager = new TokenManager(acquire, 60_000);
    const first = await manager.get();
    manager.invalidate(first.generation - 1);
    expect((await manager.get()).accessToken).toBe('one');
    manager.invalidate(first.generation);
    expect((await manager.get()).accessToken).toBe('two');
  });

  it('reuses a warm token and single-flights an expired refresh', async () => {
    let now = 0;
    const acquire = vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    const manager = new TokenManager(acquire, 60_000, () => now);
    expect((await manager.get()).accessToken).toBe('one');
    expect((await manager.get()).accessToken).toBe('one');
    now = 60_001;
    const refreshed = await Promise.all(Array.from({ length: 20 }, () => manager.get()));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(new Set(refreshed.map((value) => value.accessToken))).toEqual(new Set(['two']));
  });
});

describe('SalesforceAdapter', () => {
  function adapter(
    fetcher = vi.fn(async () => new Response(JSON.stringify({ done: true, records: [] }), { status: 200 })),
  ) {
    return new SalesforceAdapter(
      {
        salesforceOrigin: 'https://example.my.salesforce.com/',
        apiVersion: 'v65.0',
        maxResponseBytes: 100_000,
        maxRows: 100,
        maxPages: 2,
        maxConcurrentRequests: 8,
        requestTimeoutMs: 1_000,
      },
      new TokenManager(async () => 'token', 60_000),
      fetcher,
    );
  }

  it('allows bounded SOQL reads on the fixed origin', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ done: true, records: [] }), { status: 200 }));
    await adapter(fetcher).execute('soqlQuery', { query: 'SELECT Id FROM Account WHERE Id != null LIMIT 10' });
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://example.my.salesforce.com' }),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('preserves all six read operations and never emits a non-GET or another origin', async () => {
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ['getObjectSchema', {}, { sobjects: [] }],
      ['getObjectSchema', { 'object-name': 'Account' }, { name: 'Account', fields: [] }],
      ['soqlQuery', { query: 'SELECT Id FROM Account WHERE Id != null LIMIT 10' }, { done: true, records: [] }],
      ['find', { search: 'FIND {Acme} RETURNING Account(Id, Name)' }, { searchRecords: [] }],
      ['getUserInfo', {}, { user_id: '005000000000000' }],
      ['listRecentSobjectRecords', { 'sobject-name': 'Account' }, []],
      [
        'getRelatedRecords',
        { 'sobject-name': 'Account', id: '001000000000000', 'relationship-path': 'Contacts' },
        { done: true, records: [] },
      ],
    ];

    for (const [operation, input, payload] of cases) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
      await adapter(fetcher).execute(operation, input);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url.origin).toBe('https://example.my.salesforce.com');
      expect(init.method).toBe('GET');
      expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['accept', 'authorization']);
    }
  });

  it('accepts safe relationship traversal and query words inside literals', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ done: true, records: [] }), { status: 200 }));
    const instance = adapter(fetcher);
    await instance.execute('soqlQuery', {
      query: "SELECT Id FROM Account WHERE Name = 'Delete Update' LIMIT 10",
    });
    await instance.execute('getRelatedRecords', {
      'sobject-name': 'Account',
      id: '001000000000000',
      'relationship-path': 'Contacts/Cases',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['soqlQuery', { query: 'DELETE FROM Account' }],
    ['soqlQuery', { query: 'SELECT Id FROM Account LIMIT 10' }],
    ['soqlQuery', { query: 'SELECT Id FROM Account WHERE Id != null LIMIT 10; DELETE FROM Account' }],
    ['find', { search: 'FIND {Acme} RETURNING Account(Id); DELETE' }],
    ['getRelatedRecords', { 'sobject-name': 'Account', id: 'bad', 'relationship-path': 'Contacts' }],
    ['getRelatedRecords', { 'sobject-name': 'Account', id: '001000000000000', 'relationship-path': '../Contacts' }],
    ['getUserInfo', { host: 'attacker.example', method: 'POST', headers: { authorization: 'x' } }],
    ['unknown', {}],
  ])('rejects unsafe or malformed operation %s', async (name, input) => {
    await expect(adapter().execute(name, input)).rejects.toBeInstanceOf(AdapterError);
  });

  it('retries one 401 with a new token generation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(adapter(fetcher).execute('getUserInfo', {})).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses the harmless identity read for readiness and returns only a boolean', async () => {
    const fetcher = vi.fn(async () => new Response('{"active":true}', { status: 200 }));
    await expect(adapter(fetcher).readiness()).resolves.toBe(true);
    expect(fetcher.mock.calls[0]?.[0].pathname).toBe('/services/oauth2/userinfo');

    const unavailable = vi.fn(async () => new Response('{}', { status: 403 }));
    await expect(adapter(unavailable).readiness()).resolves.toBe(false);
  });

  it('coalesces refresh after concurrent 401 responses and protects the new generation', async () => {
    const acquire = vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      const authorization = (init.headers as Record<string, string>).authorization;
      return authorization === 'Bearer one'
        ? new Response('{}', { status: 401 })
        : new Response('{"ok":true}', { status: 200 });
    });
    const instance = new SalesforceAdapter(
      {
        salesforceOrigin: 'https://example.my.salesforce.com/',
        apiVersion: 'v65.0',
        maxResponseBytes: 100_000,
        maxRows: 100,
        maxPages: 2,
        maxConcurrentRequests: 32,
        requestTimeoutMs: 1_000,
      },
      new TokenManager(acquire, 60_000),
      fetcher,
    );
    await Promise.all(Array.from({ length: 20 }, () => instance.execute('getUserInfo', {})));
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('retries a 401 once at most', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(adapter(fetcher).execute('getUserInfo', {})).rejects.toEqual(new AdapterError('AUTH_UNAVAILABLE'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, 'UPSTREAM_UNAVAILABLE'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_UNAVAILABLE'],
  ])('sanitizes upstream HTTP %s', async (status, code) => {
    const fetcher = vi.fn(async () => new Response('raw upstream secret', { status }));
    await expect(adapter(fetcher).execute('getUserInfo', {})).rejects.toEqual(new AdapterError(code));
  });

  it('sanitizes timeout, DNS, reset, and malformed JSON failures', async () => {
    const failures = [
      new DOMException('timed out with detail', 'TimeoutError'),
      new Error('getaddrinfo ENOTFOUND secret-host'),
      new Error('ECONNRESET secret-host'),
    ];
    for (const failure of failures) {
      const fetcher = vi.fn(async () => {
        throw failure;
      });
      const expected = failure instanceof DOMException ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE';
      await expect(adapter(fetcher).execute('getUserInfo', {})).rejects.toEqual(new AdapterError(expected));
    }
    await expect(
      adapter(vi.fn(async () => new Response('not-json', { status: 200 }))).execute('getUserInfo', {}),
    ).rejects.toEqual(new AdapterError('UPSTREAM_UNAVAILABLE'));
  });

  it('enforces byte, row, and page bounds', async () => {
    const oversized = adapter(vi.fn(async () => new Response(JSON.stringify({ payload: 'x'.repeat(100_001) }))));
    await expect(oversized.execute('getUserInfo', {})).rejects.toEqual(new AdapterError('RESPONSE_LIMIT_EXCEEDED'));

    const rows = Array.from({ length: 150 }, (_, id) => ({ id }));
    const rowBound = await adapter(
      vi.fn(
        async () => new Response(JSON.stringify({ done: false, records: rows, nextRecordsUrl: '/services/data/x' })),
      ),
    ).execute('soqlQuery', { query: 'SELECT Id FROM Account WHERE Id != null LIMIT 200' });
    expect((rowBound as { records: unknown[] }).records).toHaveLength(100);
    expect((rowBound as { truncated: boolean }).truncated).toBe(true);

    const pageFetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ done: false, records: [{ id: 1 }], nextRecordsUrl: '/services/data/v65.0/query/x' }),
        ),
    );
    const pageBound = await adapter(pageFetcher).execute('soqlQuery', {
      query: 'SELECT Id FROM Account WHERE Id != null LIMIT 100',
    });
    expect(pageFetcher).toHaveBeenCalledTimes(2);
    expect(pageBound).toMatchObject({ done: false, truncated: true });
  });

  it('rejects an upstream pagination escape before a follow-up request', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ done: false, records: [], nextRecordsUrl: 'https://attacker.example/steal' })),
    );
    await expect(
      adapter(fetcher).execute('soqlQuery', { query: 'SELECT Id FROM Account WHERE Id != null LIMIT 10' }),
    ).rejects.toEqual(new AdapterError('UPSTREAM_UNAVAILABLE'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects excess concurrent work without sending another upstream request', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => {
      await blocked;
      return new Response('{"ok":true}', { status: 200 });
    });
    const instance = new SalesforceAdapter(
      {
        salesforceOrigin: 'https://example.my.salesforce.com/',
        apiVersion: 'v65.0',
        maxResponseBytes: 100_000,
        maxRows: 100,
        maxPages: 2,
        maxConcurrentRequests: 2,
        requestTimeoutMs: 1_000,
      },
      new TokenManager(async () => 'token', 60_000),
      fetcher,
    );
    const first = instance.execute('getUserInfo', {});
    const second = instance.execute('getUserInfo', {});
    await expect(instance.execute('getUserInfo', {})).rejects.toEqual(new AdapterError('RATE_LIMITED'));
    expect(fetcher).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
  });
});
