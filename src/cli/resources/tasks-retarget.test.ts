import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
} from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { createUser, getUser } from '../../modules/permissions/db/users.js';
import { handleRecurrence } from '../../modules/scheduling/recurrence.js';
import { clearTaskRetargetTurnsForTest, recordTaskRetargetTurn } from '../../modules/scheduling/turn-authorization.js';
import { retargetTask as retargetTaskRow } from '../../modules/scheduling/db.js';
import { inboundDbPath, initSessionFolder, outboundDbPath, writeSessionMessage } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './tasks.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-task-retarget',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-task-retarget/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-cli-task-retarget';

function now(): string {
  return new Date().toISOString();
}

function createGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function createSlackThread(group: string, sessionId: string, threadId: string, mgId = 'mg-a', channel = 'C-A'): void {
  if (!getMessagingGroup(mgId)) {
    createMessagingGroup({
      id: mgId,
      channel_type: 'slack',
      platform_id: channel,
      name: mgId,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  }
  if (!getMessagingGroupAgentByPair(mgId, group)) {
    createMessagingGroupAgent({
      id: `wire-${mgId}-${group}`,
      messaging_group_id: mgId,
      agent_group_id: group,
      engage_mode: 'mention-sticky',
      engage_pattern: null,
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
  }
  createSession({
    id: sessionId,
    agent_group_id: group,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, sessionId);
}

function ctx(sessionId: string, mgId = 'mg-a'): CallerContext {
  return { caller: 'agent', agentGroupId: 'ag-1', sessionId, messagingGroupId: mgId };
}

async function createRecurringTask(originSessionId = 'old-thread') {
  const created = await dispatch(
    {
      id: `create-${originSessionId}`,
      command: 'tasks-create',
      args: {
        name: 'test-retarget',
        prompt: 'Send the harmless test marker',
        recurrence: '0 9 * * *',
        process_after: '2999-01-01T09:00:00Z',
      },
    },
    ctx(originSessionId),
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  return created.data as { series_id: string; session_id: string; row_id: string };
}

function authorize(sessionId: string, userId = 'slack:U-MEMBER', addToGroup = true, mgId = 'mg-a'): void {
  if (!getUser(userId)) {
    createUser({ id: userId, kind: 'slack', display_name: userId, created_at: now() });
  }
  if (addToGroup) {
    addMember({ user_id: userId, agent_group_id: 'ag-1', added_by: null, added_at: now() });
  }
  const session = getSession(sessionId)!;
  const mg = getMessagingGroup(mgId)!;
  const messageId = `msg-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  writeSessionMessage('ag-1', sessionId, {
    id: messageId,
    kind: 'chat-sdk',
    timestamp: now(),
    platformId: mg.platform_id,
    channelType: 'slack',
    threadId: session.thread_id,
    content: JSON.stringify({ author: { userId: userId.slice('slack:'.length) }, text: 'Move the task here' }),
  });
  recordTaskRetargetTurn(sessionId, messageId, userId);
}

async function retarget(seriesId: string, sessionId = 'new-thread', mgId = 'mg-a') {
  return dispatch(
    { id: `retarget-${seriesId}`, command: 'tasks-retarget', args: { id: seriesId } },
    ctx(sessionId, mgId),
  );
}

describe('tasks retarget', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createGroup('ag-1');
    createSlackThread('ag-1', 'old-thread', '111.1');
    createSlackThread('ag-1', 'new-thread', '222.2');
  });

  afterEach(() => {
    clearTaskRetargetTurnsForTest();
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('requires a current authorized sender turn', async () => {
    const task = await createRecurringTask();

    const missing = await retarget(task.series_id);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('current authorized Slack message');

    authorize('new-thread', 'slack:U-UNKNOWN', false);
    const unknown = await retarget(task.series_id);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.message).toContain('not authorized');

    authorize('new-thread');
    expect((await retarget(task.series_id)).ok).toBe(true);
  });

  it('refuses a destination in another Slack channel', async () => {
    const task = await createRecurringTask();
    createSlackThread('ag-1', 'cross-channel', '333.3', 'mg-b', 'C-B');
    authorize('cross-channel', 'slack:U-MEMBER', true, 'mg-b');

    const result = await retarget(task.series_id, 'cross-channel', 'mg-b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cross-channel');
  });

  it('atomically changes route and origin, records rollback data, and keeps one live series', async () => {
    const task = await createRecurringTask();
    const dbBefore = new Database(inboundDbPath('ag-1', task.session_id));
    const before = dbBefore.prepare('SELECT * FROM messages_in WHERE id = ?').get(task.row_id) as Record<
      string,
      unknown
    >;
    dbBefore.prepare('DROP TABLE task_retarget_audit').run(); // Simulate an already-live pre-feature session DB.
    dbBefore.close();

    authorize('new-thread');
    const result = await retarget(task.series_id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = new Database(inboundDbPath('ag-1', task.session_id), { readonly: true });
    const rows = db
      .prepare("SELECT * FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused') AND series_id = ?")
      .all(task.series_id) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const after = rows[0];
    expect(after).toMatchObject({
      id: before.id,
      status: before.status,
      process_after: before.process_after,
      recurrence: before.recurrence,
      platform_id: 'C-A',
      channel_type: 'slack',
      thread_id: '222.2',
    });
    expect(JSON.parse(after.content as string)).toEqual({
      ...JSON.parse(before.content as string),
      originSessionId: 'new-thread',
    });

    const audits = db.prepare('SELECT * FROM task_retarget_audit WHERE series_id = ?').all(task.series_id) as Array<{
      id: string;
      actor_user_id: string;
      actor_session_id: string;
      before_json: string;
      after_json: string;
    }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      id: (result.data as { audit_id: string }).audit_id,
      actor_user_id: 'slack:U-MEMBER',
      actor_session_id: 'new-thread',
    });
    expect(JSON.parse(audits[0].before_json)).toMatchObject({ thread_id: '111.1', content: before.content });
    expect(JSON.parse(audits[0].after_json)).toMatchObject({ thread_id: '222.2', content: after.content });
    db.close();
  });

  it('rolls back the route update if its audit insert cannot commit', async () => {
    const task = await createRecurringTask();
    const db = new Database(inboundDbPath('ag-1', task.session_id));
    const row = db
      .prepare(
        `SELECT id, seq, status, process_after, recurrence, platform_id, channel_type, thread_id, content
           FROM messages_in
          WHERE id = ?`,
      )
      .get(task.row_id) as {
      id: string;
      seq: number;
      status: string;
      process_after: string | null;
      recurrence: string | null;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    };
    db.prepare(
      `INSERT INTO task_retarget_audit
         (id, timestamp, actor_user_id, actor_session_id, series_id, task_row_id, before_json, after_json)
       VALUES ('duplicate-audit', ?, 'slack:U-MEMBER', 'new-thread', ?, ?, '{}', '{}')`,
    ).run(now(), task.series_id, task.row_id);

    expect(() =>
      retargetTaskRow(db, {
        expected: row,
        seriesId: task.series_id,
        actorUserId: 'slack:U-MEMBER',
        actorSessionId: 'new-thread',
        platformId: 'C-A',
        channelType: 'slack',
        threadId: '222.2',
        content: JSON.stringify({ ...JSON.parse(row.content), originSessionId: 'new-thread' }),
        auditId: 'duplicate-audit',
        timestamp: now(),
      }),
    ).toThrow();

    const unchanged = db
      .prepare('SELECT platform_id, channel_type, thread_id, content FROM messages_in WHERE id = ?')
      .get(task.row_id);
    expect(unchanged).toEqual({
      platform_id: row.platform_id,
      channel_type: row.channel_type,
      thread_id: row.thread_id,
      content: row.content,
    });
    db.close();
  });

  it('future recurrence inherits the retargeted route and origin', async () => {
    const task = await createRecurringTask();
    authorize('new-thread');
    expect((await retarget(task.series_id)).ok).toBe(true);

    const db = new Database(inboundDbPath('ag-1', task.session_id));
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(task.row_id);
    await handleRecurrence(db, getSession(task.session_id)!);
    const next = db
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND series_id = ?")
      .get(task.series_id) as { platform_id: string; channel_type: string; thread_id: string; content: string };
    expect(next).toMatchObject({ platform_id: 'C-A', channel_type: 'slack', thread_id: '222.2' });
    expect(JSON.parse(next.content).originSessionId).toBe('new-thread');
    db.close();
  });

  it('refuses while the live occurrence has a processing claim', async () => {
    const task = await createRecurringTask();
    const outDb = new Database(outboundDbPath('ag-1', task.session_id));
    outDb
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)")
      .run(task.row_id, now());
    outDb.close();
    authorize('new-thread');

    const result = await retarget(task.series_id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('currently processing');
  });

  it('manual run inherits only the new thread without creating a second recurring series', async () => {
    const task = await createRecurringTask();
    authorize('new-thread');
    expect((await retarget(task.series_id)).ok).toBe(true);

    const run = await dispatch(
      { id: 'run-now', command: 'tasks-run', args: { id: task.series_id } },
      ctx('new-thread'),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const db = new Database(inboundDbPath('ag-1', task.session_id), { readonly: true });
    const rows = db
      .prepare(
        "SELECT id, recurrence, thread_id, content FROM messages_in WHERE kind = 'task' AND status = 'pending' AND series_id = ?",
      )
      .all(task.series_id) as Array<{ id: string; recurrence: string | null; thread_id: string; content: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.thread_id === '222.2')).toBe(true);
    expect(rows.every((row) => JSON.parse(row.content).originSessionId === 'new-thread')).toBe(true);
    const manual = rows.find((row) => row.id === (run.data as { row_id: string }).row_id);
    expect(manual?.recurrence).toBeNull();
    expect(rows.filter((row) => row.recurrence !== null)).toHaveLength(1);
    db.close();
  });

  it('refuses ambiguous live state instead of touching multiple occurrences', async () => {
    const task = await createRecurringTask();
    const firstRun = await dispatch(
      { id: 'run-before', command: 'tasks-run', args: { id: task.series_id } },
      ctx('old-thread'),
    );
    expect(firstRun.ok).toBe(true);
    authorize('new-thread');

    const result = await retarget(task.series_id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ambiguous');
    const count = getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE agent_group_id = ?').get('ag-1') as {
      count: number;
    };
    expect(count.count).toBe(3); // two Slack threads plus the original task session
  });
});
