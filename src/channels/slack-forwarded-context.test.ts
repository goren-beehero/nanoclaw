import { describe, expect, it } from 'vitest';

import { extractSlackForwardedMessages } from './slack-forwarded-context.js';

describe('extractSlackForwardedMessages', () => {
  it('extracts the visible body and attribution from a Slack message forward', () => {
    expect(
      extractSlackForwardedMessages({
        attachments: [
          {
            is_msg_unfurl: true,
            author_name: 'Assaf Zohar',
            text: 'Please define the experiment plan.',
            title_link: 'https://beeheroworkspace.slack.com/archives/C123/p1700000000000100',
            channel_id: 'C123',
            ts: '1700000000.000100',
          },
        ],
      }),
    ).toEqual([
      {
        text: 'Please define the experiment plan.',
        sender: 'Assaf Zohar',
        sourceUrl: 'https://beeheroworkspace.slack.com/archives/C123/p1700000000000100',
        timestamp: '1700000000.000100',
      },
    ]);
  });

  it('falls back to rich-text blocks when Slack omits attachment text', () => {
    expect(
      extractSlackForwardedMessages({
        attachments: [
          {
            is_msg_unfurl: true,
            author_id: 'U123',
            message_blocks: [
              {
                message: {
                  blocks: [
                    {
                      type: 'rich_text',
                      elements: [
                        {
                          type: 'rich_text_section',
                          elements: [
                            { type: 'text', text: 'Check ' },
                            { type: 'user', user_id: 'U456' },
                            { type: 'text', text: ' context' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([{ text: 'Check <@U456> context', sender: 'U123', sourceUrl: undefined, timestamp: undefined }]);
  });

  it('ignores ordinary URL unfurls and malformed attachments', () => {
    expect(
      extractSlackForwardedMessages({
        attachments: [
          { from_url: 'https://example.com', title: 'Example', text: 'A normal link preview' },
          { is_msg_unfurl: true },
          null,
        ],
      }),
    ).toEqual([]);
  });

  it('deduplicates repeated forward attachments', () => {
    const attachment = { is_msg_unfurl: true, text: 'same body', ts: '1700000000.000100' };
    expect(extractSlackForwardedMessages({ attachments: [attachment, { ...attachment }] })).toHaveLength(1);
  });
});
