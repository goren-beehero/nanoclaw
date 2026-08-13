import { describe, expect, it, vi } from 'vitest';

import { listSlackChannelResources } from './slack-resources.js';

function apiFetch(responses: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1).split('?')[0]!;
    const body = responses[method];
    if (!body) return new Response('missing fixture', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('listSlackChannelResources', () => {
  it('lists folders, nested bookmarks, and channel files', async () => {
    const fetchImpl = apiFetch({
      'conversations.info': {
        ok: true,
        channel: {
          name: 'bobi-testing',
          properties: {
            tabs: [
              { type: 'files', id: 'files' },
              {
                type: 'folder',
                id: 'Ct-folder',
                label: 'Finance Aus 2026',
                data: { folder_bookmark_id: 'Bk-folder' },
              },
            ],
          },
        },
      },
      'bookmarks.list': {
        ok: true,
        bookmarks: [
          {
            id: 'Bk-sheet',
            title: 'Payment terms',
            type: 'link',
            link: 'https://docs.google.com/spreadsheets/d/sheet-id',
            parent_id: 'Bk-folder',
          },
        ],
      },
      'files.list': {
        ok: true,
        files: [
          {
            id: 'F-report',
            title: 'Report.pdf',
            permalink: 'https://example.slack.com/files/F-report',
            mimetype: 'application/pdf',
            external_type: '',
          },
        ],
      },
    });

    const result = await listSlackChannelResources('xoxb-test', 'slack:C012ABC', fetchImpl as typeof fetch);

    expect(result).toEqual({
      channelName: 'bobi-testing',
      resources: [
        { id: 'Bk-folder', title: 'Finance Aus 2026', kind: 'folder' },
        {
          id: 'Bk-sheet',
          title: 'Payment terms',
          kind: 'bookmark',
          url: 'https://docs.google.com/spreadsheets/d/sheet-id',
          parentId: 'Bk-folder',
          parentTitle: 'Finance Aus 2026',
        },
        {
          id: 'F-report',
          title: 'Report.pdf',
          kind: 'file',
          url: 'https://example.slack.com/files/F-report',
          mimeType: 'application/pdf',
          externalType: '',
        },
      ],
    });
  });

  it('returns files and a precise warning when bookmarks scope is absent', async () => {
    const fetchImpl = apiFetch({
      'conversations.info': { ok: true, channel: { name: 'finance', properties: { tabs: [] } } },
      'bookmarks.list': { ok: false, error: 'missing_scope', needed: 'bookmarks:read' },
      'files.list': { ok: true, files: [{ id: 'F1', name: 'terms.csv' }] },
    });

    const result = await listSlackChannelResources('xoxb-test', 'C012ABC', fetchImpl as typeof fetch);

    expect(result.resources).toEqual([
      {
        id: 'F1',
        title: 'terms.csv',
        kind: 'file',
        url: undefined,
        mimeType: undefined,
        externalType: undefined,
      },
    ]);
    expect(result.warnings).toEqual(['bookmarks.list: missing_scope; add OAuth scope bookmarks:read']);
  });

  it('rejects caller-supplied non-Slack conversation ids before making requests', async () => {
    const fetchImpl = vi.fn();
    await expect(listSlackChannelResources('xoxb-test', 'not-a-channel', fetchImpl as typeof fetch)).rejects.toThrow(
      'Invalid Slack conversation id',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('can omit the uploaded-file inventory for compact first-turn context', async () => {
    const fetchImpl = apiFetch({
      'conversations.info': { ok: true, channel: { name: 'finance', properties: { tabs: [] } } },
      'bookmarks.list': {
        ok: true,
        bookmarks: [{ id: 'Bk1', title: 'Payment terms', type: 'link', link: 'https://example.com/terms' }],
      },
    });

    const result = await listSlackChannelResources('xoxb-test', 'C012ABC', fetchImpl as typeof fetch, {
      includeFiles: false,
    });

    expect(result.resources).toEqual([
      {
        id: 'Bk1',
        title: 'Payment terms',
        kind: 'bookmark',
        url: 'https://example.com/terms',
        parentId: undefined,
        parentTitle: undefined,
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('files.list'), expect.anything());
  });
});
