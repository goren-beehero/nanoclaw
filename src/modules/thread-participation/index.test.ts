import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import './index.js';

function now(): string {
  return new Date().toISOString();
}

let session: Session;
const unsubscribe = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  unsubscribe.mockClear();
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
    instance: 'slack-bobi',
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
  setDeliveryAdapter({ deliver: vi.fn(), unsubscribe });
});

afterEach(() => closeDb());

describe('disengage_thread delivery action', () => {
  it('unsubscribes only the exact originating route and instance', async () => {
    const handler = getDeliveryAction('disengage_thread');
    const inDb = new Database(':memory:');
    await handler!(
      {
        action: 'disengage_thread',
        channel_type: 'slack',
        platform_id: 'C-TEST',
        thread_id: session.thread_id,
        reason: 'task_complete',
      },
      session,
      inDb,
    );
    inDb.close();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledWith('slack', 'C-TEST', session.thread_id, 'slack-bobi');
  });

  it('rejects a route that does not match the originating session', async () => {
    const handler = getDeliveryAction('disengage_thread');
    const inDb = new Database(':memory:');
    await expect(
      handler!(
        {
          action: 'disengage_thread',
          channel_type: 'slack',
          platform_id: 'C-OTHER',
          thread_id: session.thread_id,
          reason: 'human_requested',
        },
        session,
        inDb,
      ),
    ).rejects.toThrow(/does not match/);
    inDb.close();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('rejects free-form reasons before they reach host logs', async () => {
    const handler = getDeliveryAction('disengage_thread');
    const inDb = new Database(':memory:');
    await expect(
      handler!(
        {
          action: 'disengage_thread',
          channel_type: 'slack',
          platform_id: 'C-TEST',
          thread_id: session.thread_id,
          reason: 'private channel text',
        },
        session,
        inDb,
      ),
    ).rejects.toThrow(/reason is invalid/);
    inDb.close();
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
