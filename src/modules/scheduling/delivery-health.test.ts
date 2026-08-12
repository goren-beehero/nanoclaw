import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import { auditSlackTaskDeliveryHealth } from './delivery-health.js';

let inDb: Database.Database;
let outDb: Database.Database;
const NOW = Date.parse('2026-08-12T10:00:00.000Z');

beforeEach(() => {
  inDb = new Database(':memory:');
  outDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  outDb.exec(OUTBOUND_SCHEMA);
  inDb
    .prepare('INSERT INTO task_delivery_health_meta (id, monitor_started_at) VALUES (1, ?)')
    .run(new Date(NOW - 24 * 60 * 60_000).toISOString());
});

function seedTask(id = 'task-1', ackStatus = 'completed') {
  inDb
    .prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, series_id)
       VALUES (?, 2, 'task', ?, 'completed', 'C-TEST', 'slack', 'thread-1', '{}', 'series-1')`,
    )
    .run(id, new Date(NOW - 10 * 60_000).toISOString());
  outDb
    .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
    .run(id, ackStatus, new Date(NOW - 6 * 60_000).toISOString());
}

function seedOutbound(id = 'out-1') {
  outDb
    .prepare(
      `INSERT INTO messages_out
         (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, 1, 'task-1', ?, 'chat', 'C-TEST', 'slack', 'thread-1', '{"text":"ok"}')`,
    )
    .run(id, new Date(NOW - 5 * 60_000).toISOString());
}

function audit() {
  return auditSlackTaskDeliveryHealth(inDb, outDb, {
    sessionId: 'session-1',
    nowMs: NOW,
    graceMs: 5 * 60_000,
    lookbackMs: 24 * 60 * 60_000,
  });
}

describe('Slack scheduled-task delivery health audit', () => {
  it('classifies no user-visible outbound row and deduplicates the occurrence', () => {
    seedTask();
    expect(audit()).toMatchObject([{ type: 'failure', classification: 'outbound_missing' }]);
    expect(audit()).toEqual([]);
  });

  it('classifies an outbound row without a Slack acknowledgement', () => {
    seedTask();
    seedOutbound();
    expect(audit()).toMatchObject([{ type: 'failure', classification: 'slack_ack_missing' }]);
  });

  it('prefers structured provider and delivery-tool failure evidence', () => {
    seedTask();
    outDb
      .prepare(
        `INSERT INTO task_run_events (id, message_id, event_type, occurred_at, detail)
         VALUES ('e1', 'task-1', 'provider_error', ?, 'rate limit'),
                ('e2', 'task-1', 'delivery_tool_error', ?, 'unknown destination')`,
      )
      .run(new Date(NOW - 8 * 60_000).toISOString(), new Date(NOW - 7 * 60_000).toISOString());
    expect(audit()).toMatchObject([{ type: 'failure', classification: 'delivery_tool_error' }]);
  });

  it('treats an error followed by acknowledged delivery as recovered telemetry', () => {
    seedTask();
    seedOutbound();
    outDb
      .prepare(
        `INSERT INTO task_run_events (id, message_id, event_type, occurred_at, detail)
         VALUES ('e1', 'task-1', 'provider_error', ?, 'retry')`,
      )
      .run(new Date(NOW - 8 * 60_000).toISOString());
    inDb
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
         VALUES ('out-1', 'slack-ts-1', 'delivered', ?)`,
      )
      .run(new Date(NOW - 4 * 60_000).toISOString());

    expect(audit()).toMatchObject([{ type: 'recovered', classification: 'provider_error' }]);
    expect(audit()).toEqual([]);
  });

  it('resolves an open finding when a late Slack acknowledgement arrives', () => {
    seedTask();
    seedOutbound();
    expect(audit()).toMatchObject([{ type: 'failure', classification: 'slack_ack_missing' }]);
    inDb
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
         VALUES ('out-1', 'slack-ts-1', 'delivered', ?)`,
      )
      .run(new Date(NOW).toISOString());
    expect(audit()).toMatchObject([{ type: 'resolved', classification: 'slack_ack_missing' }]);
  });

  it('excludes deliberate wakeAgent=false gates', () => {
    seedTask('task-1', 'script-skip:gated');
    expect(audit()).toEqual([]);
    expect(inDb.prepare('SELECT * FROM task_delivery_health').all()).toEqual([]);
  });

  it('waits for the delivery grace window', () => {
    seedTask();
    outDb
      .prepare('UPDATE processing_ack SET status_changed = ? WHERE message_id = ?')
      .run(new Date(NOW - 60_000).toISOString(), 'task-1');
    expect(audit()).toEqual([]);
  });

  it('does not backfill occurrences from before monitoring started', () => {
    seedTask();
    inDb
      .prepare('UPDATE task_delivery_health_meta SET monitor_started_at = ? WHERE id = 1')
      .run(new Date(NOW).toISOString());
    expect(audit()).toEqual([]);
  });
});
