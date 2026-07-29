/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

function publishCurrentActionSource(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_action_source', id, updatedAt);
}

function seedInboundMessage(
  id: string,
  kind: 'chat' | 'chat-sdk' | 'task',
  channelType: string,
  platformId: string,
): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, seq, kind, timestamp, trigger, channel_type, platform_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages_in), ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, kind, new Date().toISOString(), channelType, platformId, JSON.stringify({ text: 'request' }));
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(`
    CREATE TABLE session_routing (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id  TEXT,
      thread_id    TEXT
    );
    INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
    VALUES (1, 'slack', 'C-CURRENT', 'thread-current');

    INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
    VALUES
      ('current', 'Current', 'channel', 'slack', 'C-CURRENT', NULL),
      ('other', 'Other', 'channel', 'slack', 'C-OTHER', NULL),
      ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer');
  `);
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — interactive one-door delivery', () => {
  it.each(['chat', 'chat-sdk'] as const)(
    'rejects a %s send to the current conversation without writing an outbound row',
    async (kind) => {
      seedInboundMessage('current-source', kind, 'slack', 'C-CURRENT');
      publishCurrentActionSource('current-source');

      const result = await sendMessage.handler({ to: 'current', text: 'Which season do you mean?' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Nothing was sent');
      expect(result.content[0]?.text).toContain('final <message> block');
      expect(getUndeliveredMessages()).toHaveLength(0);
    },
  );

  it('allows an interactive send to a different destination', async () => {
    seedInboundMessage('current-source', 'chat', 'slack', 'C-CURRENT');
    publishCurrentActionSource('current-source');

    await sendMessage.handler({ to: 'other', text: 'Cross-channel notice' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('C-OTHER');
  });

  it('allows task delivery to the session destination', async () => {
    seedInboundMessage('task-source', 'task', 'slack', 'C-CURRENT');
    publishCurrentActionSource('task-source');

    await sendMessage.handler({ to: 'current', text: 'Scheduled result' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('C-CURRENT');
  });

  it('fails open when the action source is missing', async () => {
    await sendMessage.handler({ to: 'current', text: 'Out-of-batch message' });

    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('fails open when the stamped source row is unavailable', async () => {
    publishCurrentActionSource('missing-source');

    await sendMessage.handler({ to: 'current', text: 'Recovery message' });

    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('fails open when the action-source stamp is stale', async () => {
    seedInboundMessage('stale-source', 'chat', 'slack', 'C-CURRENT');
    publishCurrentActionSource('stale-source', 60 * 60 * 1000);

    await sendMessage.handler({ to: 'current', text: 'Recovery message' });

    expect(getUndeliveredMessages()).toHaveLength(1);
  });
});
