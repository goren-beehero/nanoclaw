import { getDb } from './connection.js';

export type SlackSuppressionDecision =
  | 'allow'
  | 'suppress_blacklisted_root'
  | 'suppress_unresolved_root'
  | 'allow_explicit_mention'
  | 'allow_previously_opened_thread';

export interface SlackThreadSuppressionPolicy {
  agentGroupId: string;
  channelId: string;
  enabled: boolean;
  suppressedRootUserIds: string[];
}

export interface SlackThreadSuppressionState {
  rootUserId: string;
  explicitlyOpened: boolean;
}

function parseUserIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))];
  } catch {
    return [];
  }
}

export function getSlackThreadSuppressionPolicy(
  agentGroupId: string,
  channelId: string,
): SlackThreadSuppressionPolicy | undefined {
  const row = getDb()
    .prepare(
      `SELECT agent_group_id, channel_id, enabled, suppressed_root_user_ids
       FROM slack_thread_suppression_policies
       WHERE agent_group_id = ? AND channel_id = ?`,
    )
    .get(agentGroupId, channelId) as
    | { agent_group_id: string; channel_id: string; enabled: number; suppressed_root_user_ids: string }
    | undefined;
  if (!row) return undefined;
  return {
    agentGroupId: row.agent_group_id,
    channelId: row.channel_id,
    enabled: row.enabled === 1,
    suppressedRootUserIds: parseUserIds(row.suppressed_root_user_ids),
  };
}

export function getSlackThreadSuppressionState(
  agentGroupId: string,
  channelId: string,
  threadId: string,
): SlackThreadSuppressionState | undefined {
  const row = getDb()
    .prepare(
      `SELECT root_user_id, explicitly_opened
       FROM slack_thread_suppression_state
       WHERE agent_group_id = ? AND channel_id = ? AND thread_id = ?`,
    )
    .get(agentGroupId, channelId, threadId) as { root_user_id: string; explicitly_opened: number } | undefined;
  return row ? { rootUserId: row.root_user_id, explicitlyOpened: row.explicitly_opened === 1 } : undefined;
}

export function saveSlackThreadSuppressionState(input: {
  agentGroupId: string;
  channelId: string;
  threadId: string;
  rootUserId: string;
  explicitlyOpened: boolean;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO slack_thread_suppression_state
         (agent_group_id, channel_id, thread_id, root_user_id, explicitly_opened, created_at, updated_at)
       VALUES (@agentGroupId, @channelId, @threadId, @rootUserId, @explicitlyOpened, @now, @now)
       ON CONFLICT (agent_group_id, channel_id, thread_id) DO UPDATE SET
         root_user_id = excluded.root_user_id,
         explicitly_opened = MAX(slack_thread_suppression_state.explicitly_opened, excluded.explicitly_opened),
         updated_at = excluded.updated_at`,
    )
    .run({ ...input, explicitlyOpened: input.explicitlyOpened ? 1 : 0, now });
}

/**
 * Record a decision once per inbound platform event. The INSERT guard keeps
 * duplicate Slack deliveries from inflating counters or being treated as a
 * second policy decision.
 */
export function recordSlackSuppressionDecision(input: {
  agentGroupId: string;
  channelId: string;
  eventId: string;
  decision: SlackSuppressionDecision;
}): boolean {
  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const inserted = getDb()
      .prepare(
        `INSERT OR IGNORE INTO slack_thread_suppression_events
           (agent_group_id, channel_id, event_id, decision, decided_at)
         VALUES (@agentGroupId, @channelId, @eventId, @decision, @now)`,
      )
      .run({ ...input, now });
    if (inserted.changes === 0) return false;

    const counter =
      input.decision === 'suppress_blacklisted_root'
        ? 'suppressed_count'
        : input.decision === 'suppress_unresolved_root'
          ? 'unresolved_root_count'
          : input.decision === 'allow_explicit_mention'
            ? 'explicit_mention_count'
            : input.decision === 'allow_previously_opened_thread'
              ? 'previously_opened_count'
              : null;
    if (counter) {
      getDb()
        .prepare(
          `UPDATE slack_thread_suppression_policies
           SET ${counter} = ${counter} + 1, last_decision_at = ?, updated_at = ?
           WHERE agent_group_id = ? AND channel_id = ?`,
        )
        .run(now, now, input.agentGroupId, input.channelId);
    }
    return true;
  })();
}

export function isSlackSuppressionEventRecorded(agentGroupId: string, channelId: string, eventId: string): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 FROM slack_thread_suppression_events
         WHERE agent_group_id = ? AND channel_id = ? AND event_id = ?`,
      )
      .get(agentGroupId, channelId, eventId),
  );
}

export function pruneSlackThreadSuppressionHistory(now = new Date()): {
  eventsDeleted: number;
  statesDeleted: number;
} {
  const eventsBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const statesBefore = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
  return getDb().transaction(() => ({
    eventsDeleted: getDb().prepare('DELETE FROM slack_thread_suppression_events WHERE decided_at < ?').run(eventsBefore)
      .changes,
    statesDeleted: getDb().prepare('DELETE FROM slack_thread_suppression_state WHERE updated_at < ?').run(statesBefore)
      .changes,
  }))();
}
