import Database from 'better-sqlite3';
import fs from 'fs';

import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { findTaskSessions, getSession } from '../../db/sessions.js';
import { canAccessAgentGroup } from '../permissions/access.js';
import { inboundDbPath, outboundDbPath, resolveTaskOriginRouting, withInboundDb } from '../../session-manager.js';
import type { CallerContext } from '../../cli/frame.js';
import type { ScheduledTaskRow } from './create.js';
import { retargetTask } from './db.js';
import { authorizeTaskRetargetTurn, consumeTaskRetargetTurn } from './turn-authorization.js';

function taskId(args: Record<string, unknown>): string {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new Error('task series id is required');
  return id;
}

function senderIdentity(rawContent: string, channelType: string): string | null {
  try {
    const content = JSON.parse(rawContent) as {
      senderId?: unknown;
      sender?: unknown;
      author?: { userId?: unknown };
    };
    const raw =
      typeof content.senderId === 'string'
        ? content.senderId
        : typeof content.sender === 'string'
          ? content.sender
          : typeof content.author?.userId === 'string'
            ? content.author.userId
            : null;
    if (!raw) return null;
    return raw.includes(':') ? raw : `${channelType}:${raw}`;
  } catch {
    return null;
  }
}

/** Move one recurring series to the exact Slack thread that requested it. */
export function retargetTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  if (ctx.caller !== 'agent') throw new Error('task retarget must be requested from the destination Slack thread');

  const callerSession = getSession(ctx.sessionId);
  if (
    !callerSession ||
    callerSession.agent_group_id !== ctx.agentGroupId ||
    !callerSession.messaging_group_id ||
    callerSession.messaging_group_id !== ctx.messagingGroupId
  ) {
    throw new Error('the current session is not an exact messaging-group route');
  }
  const targetGroup = getMessagingGroup(callerSession.messaging_group_id);
  if (!targetGroup || targetGroup.channel_type !== 'slack' || !callerSession.thread_id) {
    throw new Error('task retarget requires a current Slack thread');
  }
  const targetThreadId = callerSession.thread_id;
  if (!getMessagingGroupAgents(targetGroup.id).some((wiring) => wiring.agent_group_id === ctx.agentGroupId)) {
    throw new Error('the current Slack channel is not authorized for this agent group');
  }

  const grant = authorizeTaskRetargetTurn(ctx.sessionId);
  if (!grant.allowed) throw new Error(grant.reason);
  const access = canAccessAgentGroup(grant.userId, ctx.agentGroupId);
  if (!access.allowed) throw new Error('the current Slack sender is not authorized for this agent group');

  const callerDb = new Database(inboundDbPath(ctx.agentGroupId, ctx.sessionId), { readonly: true });
  let source:
    | {
        kind: string;
        platform_id: string | null;
        channel_type: string | null;
        thread_id: string | null;
        content: string;
      }
    | undefined;
  try {
    source = callerDb
      .prepare('SELECT kind, platform_id, channel_type, thread_id, content FROM messages_in WHERE id = ?')
      .get(grant.sourceMessageId) as typeof source;
  } finally {
    callerDb.close();
  }
  if (
    !source ||
    (source.kind !== 'chat' && source.kind !== 'chat-sdk') ||
    source.channel_type !== 'slack' ||
    source.platform_id !== targetGroup.platform_id ||
    source.thread_id !== targetThreadId ||
    senderIdentity(source.content, 'slack') !== grant.userId
  ) {
    throw new Error('the retarget request is not bound to the verified current Slack message');
  }

  const id = taskId(args);
  const candidates: Array<{ sessionId: string; row: ScheduledTaskRow }> = [];
  for (const session of findTaskSessions(ctx.agentGroupId)) {
    const dbPath = inboundDbPath(ctx.agentGroupId, session.id);
    if (!fs.existsSync(dbPath)) continue;
    const rows = withInboundDb(
      ctx.agentGroupId,
      session.id,
      (db) =>
        db
          .prepare(
            `SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq,
                  platform_id, channel_type, thread_id
             FROM messages_in
            WHERE kind = 'task'
              AND (id = ? OR series_id = ?)
              AND status IN ('pending', 'paused')`,
          )
          .all(id, id) as ScheduledTaskRow[],
    );
    for (const row of rows) candidates.push({ sessionId: session.id, row });
  }
  if (candidates.length === 0) throw new Error(`no live task matched: ${id}`);
  if (candidates.length !== 1)
    throw new Error(`task state is ambiguous: ${id} has ${candidates.length} live occurrences`);

  const { sessionId: taskSessionId, row } = candidates[0];
  if (!row.recurrence) throw new Error('only a live recurring task can be retargeted');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.content) as Record<string, unknown>;
  } catch (error) {
    throw new Error('task content is not a supported JSON envelope', { cause: error });
  }
  const oldOriginSessionId = typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null;
  const oldOriginSession = oldOriginSessionId ? getSession(oldOriginSessionId) : undefined;
  const oldRouting = resolveTaskOriginRouting(ctx.agentGroupId, oldOriginSessionId);
  if (oldOriginSession && oldOriginSession.messaging_group_id !== targetGroup.id) {
    throw new Error('cross-channel task retarget is not allowed');
  }
  if (
    !oldOriginSession ||
    !oldRouting ||
    oldRouting.channelType !== 'slack' ||
    oldRouting.platformId !== row.platform_id ||
    oldRouting.channelType !== row.channel_type ||
    oldRouting.threadId !== row.thread_id
  ) {
    throw new Error('task origin route is unknown or inconsistent');
  }
  if (row.thread_id === targetThreadId) throw new Error('task already targets the current Slack thread');

  // A due row can be claimed in the separate container-owned DB after an ACK
  // check. Refuse it as ambiguous; future/paused rows cannot enter that race.
  if (row.status === 'pending') {
    const processAt = row.process_after ? Date.parse(row.process_after) : Number.NaN;
    if (!Number.isFinite(processAt) || processAt <= Date.now()) {
      throw new Error('task is due or may be processing; retry after the occurrence completes');
    }
  }
  const taskOutDb = new Database(outboundDbPath(ctx.agentGroupId, taskSessionId), { readonly: true });
  try {
    const processing = taskOutDb
      .prepare("SELECT 1 FROM processing_ack WHERE message_id = ? AND status = 'processing' LIMIT 1")
      .get(row.row_id);
    if (processing) throw new Error('task is currently processing');
  } finally {
    taskOutDb.close();
  }

  const timestamp = new Date().toISOString();
  const auditId = `task-retarget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const updatedContent = JSON.stringify({ ...parsed, originSessionId: callerSession.id });
  withInboundDb(ctx.agentGroupId, taskSessionId, (db) =>
    retargetTask(db, {
      expected: {
        id: row.row_id,
        seq: row.seq,
        status: row.status,
        process_after: row.process_after,
        recurrence: row.recurrence,
        platform_id: row.platform_id,
        channel_type: row.channel_type,
        thread_id: row.thread_id,
        content: row.content,
      },
      seriesId: row.series_id ?? row.row_id,
      actorUserId: grant.userId,
      actorSessionId: callerSession.id,
      platformId: targetGroup.platform_id,
      channelType: 'slack',
      threadId: targetThreadId,
      content: updatedContent,
      auditId,
      timestamp,
    }),
  );
  consumeTaskRetargetTurn(ctx.sessionId, grant.sourceMessageId);

  return {
    series_id: row.series_id ?? row.row_id,
    row_id: row.row_id,
    status: row.status,
    process_after: row.process_after,
    recurrence: row.recurrence,
    origin_session_id: callerSession.id,
    from: { channel_type: row.channel_type, platform_id: row.platform_id, thread_id: row.thread_id },
    to: { channel_type: 'slack', platform_id: targetGroup.platform_id, thread_id: targetThreadId },
    audit_id: auditId,
  };
}
