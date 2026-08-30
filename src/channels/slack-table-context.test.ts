import { describe, expect, it } from 'vitest';

import { extractSlackTableText } from './slack-table-context.js';

describe('extractSlackTableText', () => {
  it('preserves native table rows as TSV text', () => {
    expect(
      extractSlackTableText({
        blocks: [
          {
            type: 'table',
            rows: [
              [
                { type: 'raw_text', text: 'Gateway' },
                { type: 'raw_text', text: 'Location' },
              ],
              [
                { type: 'raw_text', text: '90395EE5E403' },
                { type: 'raw_text', text: '-34.227527,145.911788' },
              ],
            ],
          },
        ],
      }),
    ).toEqual(['Slack table 1\n```tsv\nGateway\tLocation\n90395EE5E403\t-34.227527,145.911788\n```']);
  });

  it('preserves data-table captions, raw numbers, rich text, links, and mentions', () => {
    expect(
      extractSlackTableText({
        blocks: [
          {
            type: 'data_table',
            caption: 'Drop plan',
            rows: [
              [
                { type: 'raw_text', text: 'Pallet' },
                { type: 'raw_text', text: 'Details' },
              ],
              [
                { type: 'raw_number', value: 50 },
                {
                  type: 'rich_text',
                  elements: [
                    {
                      type: 'rich_text_section',
                      elements: [
                        { type: 'text', text: 'Owned by ' },
                        { type: 'user', user_id: 'U123' },
                        { type: 'text', text: ' - ' },
                        { type: 'link', url: 'https://example.com', text: 'map' },
                      ],
                    },
                  ],
                },
              ],
            ],
          },
        ],
      }),
    ).toEqual([
      'Slack data table: Drop plan\n```tsv\nPallet\tDetails\n50\tOwned by <@U123> - map (https://example.com)\n```',
    ]);
  });

  it('finds tables carried inside Slack attachments', () => {
    expect(
      extractSlackTableText({
        attachments: [
          {
            blocks: [
              {
                type: 'table',
                rows: [[{ type: 'raw_text', text: 'inside attachment' }]],
              },
            ],
          },
        ],
      }),
    ).toEqual(['Slack table 1\n```tsv\ninside attachment\n```']);
  });

  it('leaves tables from forwarded-message attachments in quoted context', () => {
    expect(
      extractSlackTableText({
        attachments: [
          {
            is_msg_unfurl: true,
            channel_id: 'C123',
            ts: '1700000000.000100',
            blocks: [
              {
                type: 'table',
                rows: [[{ type: 'raw_text', text: 'forwarded table' }]],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps row boundaries while making tabs and newlines safe for TSV', () => {
    expect(
      extractSlackTableText({
        blocks: [
          {
            type: 'table',
            rows: [
              [
                { type: 'raw_text', text: 'a\tb' },
                { type: 'raw_text', text: 'line 1\nline 2' },
              ],
            ],
          },
        ],
      }),
    ).toEqual(['Slack table 1\n```tsv\na b\tline 1 ↵ line 2\n```']);
  });

  it('ignores unrelated and malformed blocks', () => {
    expect(
      extractSlackTableText({
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'ordinary text' } },
          { type: 'table' },
          { type: 'data_table', rows: [null, 'bad row'] },
        ],
      }),
    ).toEqual([]);
  });

  it('bounds the number of tables retained from an untrusted payload', () => {
    const blocks = Array.from({ length: 12 }, (_, index) => ({
      type: 'table',
      rows: [[{ type: 'raw_number', value: index }]],
    }));
    expect(extractSlackTableText({ blocks })).toHaveLength(8);
  });

  it('deduplicates a table repeated across top-level and attachment blocks', () => {
    const table = { type: 'table', rows: [[{ type: 'raw_text', text: 'same table' }]] };
    expect(extractSlackTableText({ blocks: [table], attachments: [{ blocks: [table] }] })).toEqual([
      'Slack table 1\n```tsv\nsame table\n```',
    ]);
  });
});
