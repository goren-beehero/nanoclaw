import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setCurrentInReplyTo } from '../db/session-state.js';
import { invokeToolWithDeliveryHealth } from './server.js';
import type { McpToolDefinition } from './types.js';

beforeEach(() => {
  initTestSessionDb();
  setCurrentInReplyTo('task-1');
});

afterEach(() => {
  closeSessionDb();
});

function tool(name: string, handler: McpToolDefinition['handler']): McpToolDefinition {
  return {
    tool: { name, description: name, inputSchema: { type: 'object' } },
    handler,
  };
}

function events() {
  return getOutboundDb()
    .prepare('SELECT message_id, event_type, detail FROM task_run_events ORDER BY occurred_at')
    .all() as Array<{ message_id: string; event_type: string; detail: string }>;
}

describe('delivery-tool health evidence', () => {
  it('records a structured event when send_message returns an MCP error', async () => {
    await invokeToolWithDeliveryHealth(
      'send_message',
      tool('send_message', async () => ({
        content: [{ type: 'text', text: 'Error: unknown destination' }],
        isError: true,
      })),
      {},
    );
    expect(events()).toEqual([
      {
        message_id: 'task-1',
        event_type: 'delivery_tool_error',
        detail: 'send_message: Error: unknown destination',
      },
    ]);
  });

  it('records a thrown send_file failure and preserves the throw', async () => {
    expect(
      invokeToolWithDeliveryHealth(
        'send_file',
        tool('send_file', async () => {
          throw new Error('copy failed');
        }),
        {},
      ),
    ).rejects.toThrow('copy failed');
    expect(events()[0]).toMatchObject({
      message_id: 'task-1',
      event_type: 'delivery_tool_error',
      detail: 'send_file: copy failed',
    });
  });

  it('does not record healthy delivery or errors from unrelated tools', async () => {
    await invokeToolWithDeliveryHealth(
      'send_message',
      tool('send_message', async () => ({ content: [{ type: 'text', text: 'sent' }] })),
      {},
    );
    await invokeToolWithDeliveryHealth(
      'read_data',
      tool('read_data', async () => ({ content: [{ type: 'text', text: 'Error: unavailable' }], isError: true })),
      {},
    );
    expect(events()).toEqual([]);
  });
});
