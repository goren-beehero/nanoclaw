/**
 * Task DB helpers used by the scheduling module.
 *
 * Tasks are `messages_in` rows with `kind='task'`. This module doesn't own
 * its own table — it piggybacks on the core schema. That's why there's no
 * `module-scheduling-*.ts` migration file.
 *
 * cancel/pause/resume match any live row in the series, not just the exact id.
 * Recurring tasks get a new row per occurrence (see handleRecurrence), all
 * sharing series_id. Matching by id alone would only hit the completed row
 * the agent remembers, missing the live next occurrence.
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq } from '../../db/session-db.js';

/**
 * Insert one pending task occurrence. `seriesId` is the series join key — equal
 * to `id` for a brand-new series, or the existing series for a recurrence clone
 * or an on-demand run. Slack-origin tasks retain the creating conversation's
 * route so an isolated run can reply to that exact thread.
 */
export function insertTaskRow(
  db: Database.Database,
  row: {
    id: string;
    seriesId: string;
    processAfter: string | null;
    recurrence: string | null;
    content: string;
    status?: 'pending' | 'paused';
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
     VALUES (@id, @seq, @timestamp, @status, 0, @processAfter, @recurrence, 'task', @platformId, @channelType, @threadId, @content, @seriesId)`,
  ).run({
    status: 'pending',
    platformId: null,
    channelType: null,
    threadId: null,
    ...row,
    timestamp: new Date().toISOString(),
    seq: nextEvenSeq(db),
  });
}

// Cancel marks the live row 'cancelled' (not 'completed') so a never-fired
// occurrence is distinguishable from a real run and never inflates run history;
// recurrence is cleared so the series isn't re-armed by handleRecurrence.
export function cancelTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run(taskId, taskId).changes;
}

export function cancelAllTasks(db: Database.Database): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run().changes;
}

export function pauseTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'paused' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'pending'",
    )
    .run(taskId, taskId).changes;
}

export function resumeTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'pending' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'paused'",
    )
    .run(taskId, taskId).changes;
}

export function deleteTask(db: Database.Database, taskId: string): number {
  return db.prepare("DELETE FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'").run(taskId, taskId)
    .changes;
}

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

export interface TaskRetargetRoute {
  platformId: string;
  channelType: string;
  threadId: string;
  originSessionId: string;
  originMessagingGroupId: string;
}

export interface TaskRetargetResult {
  seriesId: string;
  rowIds: string[];
  touched: number;
  unchanged: boolean;
  statuses: string[];
  nextRun: string | null;
  recurrence: string | null;
  from: {
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    originSessionId: string | null;
    originMessagingGroupId: string | null;
  };
  to: TaskRetargetRoute;
}

type LiveTaskRetargetRow = {
  id: string;
  seq: number;
  series_id: string | null;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
};

/** Live row IDs for one exact task series, used to reject already-claimed work. */
export function getLiveTaskRowIds(db: Database.Database, taskId: string): string[] {
  return (
    db
      .prepare(
        `SELECT id
           FROM messages_in
          WHERE kind = 'task'
            AND (id = ? OR series_id = ?)
            AND status IN ('pending', 'paused')
          ORDER BY seq`,
      )
      .all(taskId, taskId) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** A pending task that is already due may be claimed by its polling worker at any instant. */
export function hasDueLiveTaskRow(db: Database.Database, taskId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
           FROM messages_in
          WHERE kind = 'task'
            AND (id = ? OR series_id = ?)
            AND status = 'pending'
            AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          LIMIT 1`,
      )
      .get(taskId, taskId),
  );
}

/**
 * Move every unclaimed live occurrence in one series to a caller-derived
 * route. Only the four routing values change. The compare-and-update loop is
 * one SQLite transaction, so any stale row or write failure rolls everything
 * back. Completed history is never selected.
 */
export function retargetTaskSeries(
  db: Database.Database,
  taskId: string,
  to: TaskRetargetRoute,
): TaskRetargetResult | null {
  const rows = db
    .prepare(
      `SELECT id, seq, series_id, status, process_after, recurrence,
              platform_id, channel_type, thread_id, content
         FROM messages_in
        WHERE kind = 'task'
          AND (id = ? OR series_id = ?)
          AND status IN ('pending', 'paused')
        ORDER BY seq`,
    )
    .all(taskId, taskId) as LiveTaskRetargetRow[];
  if (rows.length === 0) return null;

  const seriesIds = new Set(rows.map((row) => row.series_id ?? row.id));
  if (seriesIds.size !== 1) throw new Error(`task state is ambiguous: ${taskId}`);

  const prepared = rows.map((row) => {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(row.content) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`task has unsupported legacy content: ${taskId}`, { cause: error });
    }
    if (!content || Array.isArray(content) || typeof content !== 'object') {
      throw new Error(`task has unsupported content: ${taskId}`);
    }
    const originSessionId = typeof content.originSessionId === 'string' ? content.originSessionId : null;
    const originMessagingGroupId =
      typeof content.originMessagingGroupId === 'string' ? content.originMessagingGroupId : null;
    const unchanged =
      row.platform_id === to.platformId &&
      row.channel_type === to.channelType &&
      row.thread_id === to.threadId &&
      originSessionId === to.originSessionId &&
      originMessagingGroupId === to.originMessagingGroupId;
    return {
      row,
      originSessionId,
      originMessagingGroupId,
      unchanged,
      content: unchanged
        ? row.content
        : JSON.stringify({
            ...content,
            originSessionId: to.originSessionId,
            originMessagingGroupId: to.originMessagingGroupId,
          }),
    };
  });

  const scheduleRow = rows.find((row) => row.recurrence !== null) ?? rows[0];
  const result: TaskRetargetResult = {
    seriesId: [...seriesIds][0],
    rowIds: rows.map((row) => row.id),
    touched: 0,
    unchanged: prepared.every((entry) => entry.unchanged),
    statuses: [...new Set(rows.map((row) => row.status))],
    nextRun: scheduleRow.process_after,
    recurrence: scheduleRow.recurrence,
    from: {
      platformId: rows[0].platform_id,
      channelType: rows[0].channel_type,
      threadId: rows[0].thread_id,
      originSessionId: prepared[0].originSessionId,
      originMessagingGroupId: prepared[0].originMessagingGroupId,
    },
    to,
  };
  if (result.unchanged) return result;

  const update = db.prepare(
    `UPDATE messages_in
        SET platform_id = @platformId,
            channel_type = @channelType,
            thread_id = @threadId,
            content = @newContent
      WHERE id = @id
        AND seq = @seq
        AND status = @status
        AND process_after IS @processAfter
        AND recurrence IS @recurrence
        AND platform_id IS @oldPlatformId
        AND channel_type IS @oldChannelType
        AND thread_id IS @oldThreadId
        AND content = @oldContent
        AND (
          status = 'paused'
          OR (
            status = 'pending'
            AND process_after IS NOT NULL
            AND datetime(process_after) > datetime('now')
          )
        )`,
  );
  const tx = db.transaction(() => {
    // Recheck inside the write transaction. The CLI performs the same check
    // for a clearer early error, but a warm poller can race that outer read as
    // the task crosses its due time.
    if (hasDueLiveTaskRow(db, taskId)) {
      throw new Error('task is currently due to run; no changes were made');
    }
    for (const entry of prepared) {
      const changed = update.run({
        id: entry.row.id,
        seq: entry.row.seq,
        status: entry.row.status,
        processAfter: entry.row.process_after,
        recurrence: entry.row.recurrence,
        oldPlatformId: entry.row.platform_id,
        oldChannelType: entry.row.channel_type,
        oldThreadId: entry.row.thread_id,
        oldContent: entry.row.content,
        platformId: to.platformId,
        channelType: to.channelType,
        threadId: to.threadId,
        newContent: entry.content,
      }).changes;
      if (changed !== 1) throw new Error('task changed while retargeting; retry later');
    }
  });
  tx();
  result.touched = rows.length;
  return result;
}

// Merges content JSON in-place so callers can update prompt/script without
// clobbering other fields. Matches by id OR series_id so the live next
// occurrence of a recurring task is updated, not just the completed row the
// agent last saw. Returns the number of rows touched.
export function updateTask(db: Database.Database, taskId: string, update: TaskUpdate): number {
  const rows = db
    .prepare(
      "SELECT id, content FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
    )
    .all(taskId, taskId) as Array<{ id: string; content: string }>;

  if (rows.length === 0) return 0;

  const setProcessAfter = update.processAfter !== undefined;
  const setRecurrence = update.recurrence !== undefined;
  const mergeContent = update.prompt !== undefined || update.script !== undefined;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let content = row.content;
      if (mergeContent) {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (update.prompt !== undefined) parsed.prompt = update.prompt;
        if (update.script !== undefined) parsed.script = update.script;
        content = JSON.stringify(parsed);
      }

      // Build SET clause dynamically so callers can update fields independently.
      const sets: string[] = ['content = ?'];
      const params: unknown[] = [content];
      if (setProcessAfter) {
        sets.push('process_after = ?');
        params.push(update.processAfter);
      }
      if (setRecurrence) {
        sets.push('recurrence = ?');
        params.push(update.recurrence);
      }
      params.push(row.id);

      db.prepare(`UPDATE messages_in SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
  });
  tx();
  return rows.length;
}

// Only tasks carry a recurrence (non-task writeSessionMessage never sets one),
// so getCompletedRecurring only ever returns task rows — the fields below are
// all that handleRecurrence needs to clone the next occurrence.
export interface RecurringMessage {
  id: string;
  content: string;
  recurrence: string;
  series_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

// Failed occurrences (script-skip:error runs) re-arm too — a broken monitor
// must keep its series alive so backoff can throttle it and the cap can pause
// it; dropping the row would silently kill the series on first script error.
export function getCompletedRecurring(db: Database.Database): RecurringMessage[] {
  return db
    .prepare("SELECT * FROM messages_in WHERE status IN ('completed', 'failed') AND recurrence IS NOT NULL")
    .all() as RecurringMessage[];
}

/**
 * Trailing consecutive FAILED occurrences of a series, newest backwards until
 * the first completed run. This IS the script-failure streak — derived from
 * the occurrence history, no stored counter to update or reset. Deliberately
 * counts ANY failed occurrence (script-skip:error acks AND stuck-message
 * failures from host-sweep's MAX_TRIES path): a series failing for either
 * reason should throttle, not spin.
 */
export function trailingFailedRuns(db: Database.Database, seriesKey: string): number {
  const rows = db
    .prepare(
      `SELECT status FROM messages_in
        WHERE (series_id = ? OR id = ?) AND kind = 'task' AND status IN ('completed', 'failed')
        ORDER BY seq DESC`,
    )
    .all(seriesKey, seriesKey) as Array<{ status: string }>;
  let streak = 0;
  for (const r of rows) {
    if (r.status !== 'failed') break;
    streak++;
  }
  return streak;
}

export function insertRecurrence(
  db: Database.Database,
  msg: RecurringMessage,
  newId: string,
  nextRun: string | null,
  status: 'pending' | 'paused' = 'pending',
): void {
  insertTaskRow(db, {
    id: newId,
    seriesId: msg.series_id,
    processAfter: nextRun,
    recurrence: msg.recurrence,
    content: msg.content,
    status,
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
  });
}

export function clearRecurrence(db: Database.Database, messageId: string): void {
  db.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(messageId);
}
