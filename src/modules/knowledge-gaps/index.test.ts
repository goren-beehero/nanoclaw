import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { cleanupKnowledgeGapTestRun } from '../../db/knowledge-gaps.js';
import { getDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import './index.js';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-bobi',
    name: 'Bobi',
    folder: 'bobi',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-test',
    channel_type: 'slack',
    platform_id: 'C-TEST',
    name: 'bobi-testing',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  session = {
    id: 'sess-test',
    agent_group_id: 'ag-bobi',
    messaging_group_id: 'mg-test',
    thread_id: 'slack:C-TEST:123.456',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  createSession(session);
});

afterEach(() => closeDb());

describe('record_knowledge_gap delivery action', () => {
  it('captures internally without changing Slack thread routing state', async () => {
    getDb()
      .prepare(
        `INSERT INTO knowledge_gap_test_scopes
           (channel_type, platform_id, thread_id, test_run_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('slack', 'C-TEST', session.thread_id, 'test-run-1', '2999-01-01T00:00:00.000Z', now());

    const handler = getDeliveryAction('record_knowledge_gap');
    expect(handler).toBeDefined();
    const inDb = new Database(':memory:');
    await handler!(
      {
        action: 'record_knowledge_gap',
        category: 'unsupported_action',
        capability_key: 'run production airflow backfill',
        summary: 'Execute a production backfill',
        scope_boundary: 'Mutation is unavailable',
        route_attempted: 'Airflow read-only investigation',
        source_message_id: 'slack-message-1',
      },
      session,
      inDb,
    );
    inDb.close();

    const gap = getDb().prepare('SELECT * FROM knowledge_gaps').get() as {
      fingerprint: string;
      occurrence_count: number;
      test_run_id: string | null;
    };
    const occurrence = getDb().prepare('SELECT * FROM knowledge_gap_occurrences').get() as {
      platform_id: string;
      thread_id: string;
      test_run_id: string | null;
    };
    expect(gap.occurrence_count).toBe(1);
    expect(gap.test_run_id).toBe('test-run-1');
    expect(occurrence).toMatchObject({
      platform_id: 'C-TEST',
      thread_id: session.thread_id,
      test_run_id: 'test-run-1',
    });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM slack_out_of_scope_threads').get() as { n: number }).n).toBe(0);
    expect(cleanupKnowledgeGapTestRun('test-run-1')).toEqual({
      occurrencesDeleted: 1,
      gapsDeleted: 1,
      threadClosuresDeleted: 0,
    });
  });

  it('rejects malformed events without affecting user-facing routing state', async () => {
    const handler = getDeliveryAction('record_knowledge_gap');
    const inDb = new Database(':memory:');
    await expect(
      handler!(
        {
          action: 'record_knowledge_gap',
          category: 'missing_route',
          capability_key: '',
        },
        session,
        inDb,
      ),
    ).rejects.toThrow(/required/);
    inDb.close();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_gaps').get() as { n: number }).n).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM slack_out_of_scope_threads').get() as { n: number }).n).toBe(0);
    expect(session.messaging_group_id).toBe('mg-test');
    expect(session.thread_id).toBe('slack:C-TEST:123.456');
  });
});
