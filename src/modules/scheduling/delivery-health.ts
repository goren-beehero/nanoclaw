/**
 * Observational health audit for completed Slack-origin scheduled-task runs.
 *
 * This module only reads task/runtime evidence and writes its own audit table.
 * It never changes task state, schedules work, or asks the container to rerun.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

export type DeliveryHealthClassification =
  | 'provider_error'
  | 'delivery_tool_error'
  | 'outbound_missing'
  | 'slack_ack_missing'
  | 'unknown';

export interface DeliveryHealthNotice {
  type: 'failure' | 'resolved' | 'recovered';
  taskMessageId: string;
  seriesId: string;
  classification: DeliveryHealthClassification;
  details: Record<string, unknown>;
}

interface TaskRow {
  id: string;
  series_id: string;
  platform_id: string;
  thread_id: string | null;
  ack_status: string;
  status_changed: string;
}

interface OutboundRow {
  id: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

interface RunEventRow {
  event_type: 'provider_error' | 'delivery_tool_error';
  occurred_at: string;
  detail: string;
}

interface HealthRow {
  classification: DeliveryHealthClassification;
  state: 'open' | 'resolved' | 'recovered';
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function parseTimestamp(value: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
}

function ensureHealthTable(inDb: Database.Database, nowIso: string): number {
  inDb.exec(`
    CREATE TABLE IF NOT EXISTS task_delivery_health (
      task_message_id TEXT PRIMARY KEY,
      classification TEXT NOT NULL,
      state          TEXT NOT NULL,
      details        TEXT NOT NULL,
      first_seen     TEXT NOT NULL,
      last_seen      TEXT NOT NULL,
      resolved_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS task_delivery_health_meta (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      monitor_started_at TEXT NOT NULL
    );
  `);
  inDb.prepare('INSERT OR IGNORE INTO task_delivery_health_meta (id, monitor_started_at) VALUES (1, ?)').run(nowIso);
  const row = inDb.prepare('SELECT monitor_started_at FROM task_delivery_health_meta WHERE id = 1').get() as {
    monitor_started_at: string;
  };
  return parseTimestamp(row.monitor_started_at);
}

function getRunEvents(outDb: Database.Database, messageId: string): RunEventRow[] {
  try {
    return outDb
      .prepare(
        `SELECT event_type, occurred_at, detail
           FROM task_run_events
          WHERE message_id = ?
            AND event_type IN ('provider_error', 'delivery_tool_error')
          ORDER BY occurred_at ASC`,
      )
      .all(messageId) as RunEventRow[];
  } catch (error) {
    // Existing session DBs get the table on their next container start. Until
    // then the audit still distinguishes missing outbound from missing Slack ack.
    if (error instanceof Error && error.message.includes('no such table: task_run_events')) return [];
    throw error;
  }
}

function latestError(events: RunEventRow[]): DeliveryHealthClassification | null {
  const event = events.at(-1);
  return event?.event_type ?? null;
}

function threadMatches(origin: string | null, outbound: string | null): boolean {
  return origin === outbound;
}

function classifyFailure(
  allOutbound: OutboundRow[],
  matchingOutbound: OutboundRow[],
  events: RunEventRow[],
): DeliveryHealthClassification {
  const runtimeError = latestError(events);
  if (runtimeError) return runtimeError;
  if (allOutbound.length === 0) return 'outbound_missing';
  if (matchingOutbound.length > 0) return 'slack_ack_missing';
  return 'unknown';
}

function deliveredSlackIds(inDb: Database.Database, outbound: OutboundRow[]): string[] {
  const delivered = inDb.prepare(
    `SELECT 1
       FROM delivered
      WHERE message_out_id = ?
        AND status = 'delivered'
        AND platform_message_id IS NOT NULL
      LIMIT 1`,
  );
  return outbound.filter((message) => delivered.get(message.id) !== undefined).map((message) => message.id);
}

function persistFailure(
  inDb: Database.Database,
  task: TaskRow,
  classification: DeliveryHealthClassification,
  details: Record<string, unknown>,
  nowIso: string,
): DeliveryHealthNotice | null {
  const previous = inDb
    .prepare('SELECT classification, state FROM task_delivery_health WHERE task_message_id = ?')
    .get(task.id) as HealthRow | undefined;
  const detailsJson = JSON.stringify(details);

  if (!previous) {
    inDb
      .prepare(
        `INSERT INTO task_delivery_health
           (task_message_id, classification, state, details, first_seen, last_seen, resolved_at)
         VALUES (?, ?, 'open', ?, ?, ?, NULL)`,
      )
      .run(task.id, classification, detailsJson, nowIso, nowIso);
  } else {
    inDb
      .prepare(
        `UPDATE task_delivery_health
            SET classification = ?, state = 'open', details = ?, last_seen = ?, resolved_at = NULL
          WHERE task_message_id = ?`,
      )
      .run(classification, detailsJson, nowIso, task.id);
  }

  if (previous?.state === 'open' && previous.classification === classification) return null;
  return { type: 'failure', taskMessageId: task.id, seriesId: task.series_id, classification, details };
}

function persistHealthy(
  inDb: Database.Database,
  task: TaskRow,
  events: RunEventRow[],
  deliveredIds: string[],
  nowIso: string,
): DeliveryHealthNotice | null {
  const previous = inDb
    .prepare('SELECT classification, state FROM task_delivery_health WHERE task_message_id = ?')
    .get(task.id) as HealthRow | undefined;
  const recoveredClassification = latestError(events);
  const details = { deliveredMessageIds: deliveredIds, recoveredEventCount: events.length };

  if (recoveredClassification) {
    inDb
      .prepare(
        `INSERT INTO task_delivery_health
           (task_message_id, classification, state, details, first_seen, last_seen, resolved_at)
         VALUES (?, ?, 'recovered', ?, ?, ?, ?)
         ON CONFLICT(task_message_id) DO UPDATE SET
           classification = excluded.classification,
           state = 'recovered',
           details = excluded.details,
           last_seen = excluded.last_seen,
           resolved_at = excluded.resolved_at`,
      )
      .run(task.id, recoveredClassification, JSON.stringify(details), nowIso, nowIso, nowIso);
    if (previous?.state === 'recovered' && previous.classification === recoveredClassification) return null;
    return {
      type: 'recovered',
      taskMessageId: task.id,
      seriesId: task.series_id,
      classification: recoveredClassification,
      details,
    };
  }

  if (previous?.state !== 'open') return null;
  inDb
    .prepare(
      `UPDATE task_delivery_health
          SET state = 'resolved', details = ?, last_seen = ?, resolved_at = ?
        WHERE task_message_id = ?`,
    )
    .run(JSON.stringify(details), nowIso, nowIso, task.id);
  return {
    type: 'resolved',
    taskMessageId: task.id,
    seriesId: task.series_id,
    classification: previous.classification,
    details,
  };
}

function persistGatedResolution(inDb: Database.Database, task: TaskRow, nowIso: string): DeliveryHealthNotice | null {
  const previous = inDb
    .prepare('SELECT classification, state FROM task_delivery_health WHERE task_message_id = ?')
    .get(task.id) as HealthRow | undefined;
  if (previous?.state !== 'open') return null;
  const details = { reason: 'wakeAgent=false' };
  inDb
    .prepare(
      `UPDATE task_delivery_health
          SET state = 'resolved', details = ?, last_seen = ?, resolved_at = ?
        WHERE task_message_id = ?`,
    )
    .run(JSON.stringify(details), nowIso, nowIso, task.id);
  return {
    type: 'resolved',
    taskMessageId: task.id,
    seriesId: task.series_id,
    classification: previous.classification,
    details,
  };
}

export function auditSlackTaskDeliveryHealth(
  inDb: Database.Database,
  outDb: Database.Database,
  options: { sessionId: string; nowMs?: number; graceMs?: number; lookbackMs?: number },
): DeliveryHealthNotice[] {
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const nowIso = new Date(nowMs).toISOString();
  const monitorStartedAtMs = ensureHealthTable(inDb, nowIso);
  const notices: DeliveryHealthNotice[] = [];
  const inboundTasks = inDb
    .prepare(
      `SELECT id, COALESCE(series_id, id) AS series_id, platform_id, thread_id
         FROM messages_in
        WHERE kind = 'task'
          AND status = 'completed'
          AND channel_type = 'slack'
          AND platform_id IS NOT NULL`,
    )
    .all() as Array<Pick<TaskRow, 'id' | 'series_id' | 'platform_id' | 'thread_id'>>;
  const tasks = inboundTasks.flatMap((task) => {
    const ack = outDb
      .prepare(
        `SELECT status AS ack_status, status_changed
           FROM processing_ack
          WHERE message_id = ?
            AND status IN ('completed', 'script-skip:gated')`,
      )
      .get(task.id) as Pick<TaskRow, 'ack_status' | 'status_changed'> | undefined;
    return ack ? [{ ...task, ...ack }] : [];
  });

  for (const task of tasks) {
    const completedAt = parseTimestamp(task.status_changed);
    if (!Number.isFinite(completedAt) || nowMs - completedAt < graceMs) continue;
    const tracked = inDb
      .prepare("SELECT 1 FROM task_delivery_health WHERE task_message_id = ? AND state = 'open'")
      .get(task.id);
    if ((completedAt < monitorStartedAtMs || nowMs - completedAt > lookbackMs) && !tracked) continue;

    if (task.ack_status === 'script-skip:gated') {
      const notice = persistGatedResolution(inDb, task, nowIso);
      if (notice) notices.push(notice);
      continue;
    }

    const allOutbound = outDb
      .prepare(
        `SELECT id, channel_type, platform_id, thread_id
           FROM messages_out
          WHERE in_reply_to = ? AND kind = 'chat'`,
      )
      .all(task.id) as OutboundRow[];
    const matchingOutbound = allOutbound.filter(
      (message) =>
        message.channel_type === 'slack' &&
        message.platform_id === task.platform_id &&
        threadMatches(task.thread_id, message.thread_id),
    );
    const deliveredIds = deliveredSlackIds(inDb, matchingOutbound);
    const events = getRunEvents(outDb, task.id);

    let notice: DeliveryHealthNotice | null;
    if (deliveredIds.length > 0) {
      notice = persistHealthy(inDb, task, events, deliveredIds, nowIso);
    } else {
      const classification = classifyFailure(allOutbound, matchingOutbound, events);
      notice = persistFailure(
        inDb,
        task,
        classification,
        {
          ackChangedAt: task.status_changed,
          outboundMessageIds: allOutbound.map((message) => message.id),
          matchingOutboundMessageIds: matchingOutbound.map((message) => message.id),
          eventTypes: events.map((event) => event.event_type),
          latestEventDetail: events.at(-1)?.detail ?? null,
        },
        nowIso,
      );
    }
    if (notice) notices.push(notice);
  }

  for (const notice of notices) {
    const fields = {
      sessionId: options.sessionId,
      taskMessageId: notice.taskMessageId,
      seriesId: notice.seriesId,
      classification: notice.classification,
      ...notice.details,
    };
    if (notice.type === 'failure') log.warn('Scheduled task delivery health failure', fields);
    else log.info(`Scheduled task delivery health ${notice.type}`, fields);
  }
  return notices;
}
