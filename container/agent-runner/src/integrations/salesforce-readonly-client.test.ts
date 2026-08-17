import { afterEach, describe, expect, it, mock } from 'bun:test';

import { callAdapter, hasPrivateAdapterProxyBypass, salesforceTools } from './salesforce-readonly-client.js';
import fixture from './salesforce-sobject-reads-tools.fixture.json';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Salesforce readonly MCP client', () => {
  it('fails closed when a proxy is configured without the exact private adapter bypass', () => {
    expect(hasPrivateAdapterProxyBypass({})).toBe(true);
    expect(hasPrivateAdapterProxyBypass({ HTTP_PROXY: 'http://proxy.invalid' })).toBe(false);
    expect(hasPrivateAdapterProxyBypass({ HTTP_PROXY: 'http://proxy.invalid', NO_PROXY: '*' })).toBe(false);
    expect(
      hasPrivateAdapterProxyBypass({
        HTTP_PROXY: 'http://proxy.invalid',
        NO_PROXY: 'localhost,bobi-salesforce-readonly-adapter',
      }),
    ).toBe(true);
    expect(
      hasPrivateAdapterProxyBypass({
        HTTP_PROXY: 'http://proxy.invalid',
        no_proxy: 'bobi-salesforce-readonly-adapter',
      }),
    ).toBe(true);
  });

  it('publishes the exact six-tool compatibility surface', () => {
    expect(salesforceTools.map((tool) => tool.name)).toEqual([
      'getObjectSchema',
      'soqlQuery',
      'find',
      'getUserInfo',
      'listRecentSobjectRecords',
      'getRelatedRecords',
    ]);
  });

  it('matches the retained non-sensitive descriptions and input fields', () => {
    expect(
      salesforceTools.map((tool) => {
        const properties = Object.keys(tool.inputSchema.properties ?? {});
        const required = [...(tool.inputSchema.required ?? [])];
        return {
          name: tool.name,
          description: tool.description,
          required,
          optional: properties.filter((name) => !required.includes(name)),
        };
      }),
    ).toEqual(fixture);
    for (const tool of salesforceTools) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('uses only the compiled adapter origin and tool path', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await callAdapter('soqlQuery', {
      query: 'SELECT Id FROM Account WHERE Id != null LIMIT 1',
      host: 'https://evil.example',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://bobi-salesforce-readonly-adapter:8080/v1/tools/soqlQuery');
    expect(init.method).toBe('POST');
  });

  it('sanitizes unrecognized adapter errors', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ ok: false, error: 'raw secret error' }), { status: 500 }),
    ) as typeof fetch;
    expect(callAdapter('getUserInfo', {})).rejects.toThrow('UPSTREAM_UNAVAILABLE');
  });
});
