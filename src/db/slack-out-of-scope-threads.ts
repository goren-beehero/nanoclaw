import { getDb } from './connection.js';

export interface SlackOutOfScopeThread {
  agentGroupId: string;
  channelId: string;
  threadId: string;
  knowledgeGapFingerprint: string;
  sourceEventKey: string;
  testRunId: string | null;
  suppressedCount: number;
  closedAt: string;
  updatedAt: string;
}

interface SlackOutOfScopeThreadRow {
  agent_group_id: string;
  channel_id: string;
  thread_id: string;
  knowledge_gap_fingerprint: string;
  source_event_key: string;
  test_run_id: string | null;
  suppressed_count: number;
  closed_at: string;
  updated_at: string;
}

function fromRow(row: SlackOutOfScopeThreadRow): SlackOutOfScopeThread {
  return {
    agentGroupId: row.agent_group_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    knowledgeGapFingerprint: row.knowledge_gap_fingerprint,
    sourceEventKey: row.source_event_key,
    testRunId: row.test_run_id,
    suppressedCount: row.suppressed_count,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  };
}

export function getSlackOutOfScopeThread(
  agentGroupId: string,
  channelId: string,
  threadId: string,
): SlackOutOfScopeThread | undefined {
  const row = getDb()
    .prepare(
      `SELECT agent_group_id, channel_id, thread_id, knowledge_gap_fingerprint,
              source_event_key, test_run_id, suppressed_count, closed_at, updated_at
       FROM slack_out_of_scope_threads
       WHERE agent_group_id = ? AND channel_id = ? AND thread_id = ?`,
    )
    .get(agentGroupId, channelId, threadId) as SlackOutOfScopeThreadRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function closeSlackOutOfScopeThread(input: {
  agentGroupId: string;
  channelId: string;
  threadId: string;
  knowledgeGapFingerprint: string;
  sourceEventKey: string;
  testRunId?: string | null;
}): SlackOutOfScopeThread {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO slack_out_of_scope_threads
         (agent_group_id, channel_id, thread_id, knowledge_gap_fingerprint,
          source_event_key, test_run_id, closed_at, updated_at)
       VALUES (@agentGroupId, @channelId, @threadId, @knowledgeGapFingerprint,
               @sourceEventKey, @testRunId, @now, @now)
       ON CONFLICT (agent_group_id, channel_id, thread_id) DO UPDATE SET
         knowledge_gap_fingerprint = excluded.knowledge_gap_fingerprint,
         source_event_key = excluded.source_event_key,
         test_run_id = excluded.test_run_id,
         updated_at = excluded.updated_at`,
    )
    .run({ ...input, testRunId: input.testRunId ?? null, now });
  return getSlackOutOfScopeThread(input.agentGroupId, input.channelId, input.threadId)!;
}

export function suppressSlackOutOfScopeThreadReply(input: {
  agentGroupId: string;
  channelId: string;
  threadId: string;
  messageId: string;
}): boolean {
  const now = new Date().toISOString();
  return (
    getDb()
      .prepare(
        `UPDATE slack_out_of_scope_threads SET
           suppressed_count = suppressed_count + CASE
             WHEN last_suppressed_message_id IS @messageId THEN 0 ELSE 1 END,
           last_suppressed_message_id = @messageId,
           last_suppressed_at = @now,
           updated_at = @now
         WHERE agent_group_id = @agentGroupId
           AND channel_id = @channelId
           AND thread_id = @threadId`,
      )
      .run({ ...input, now }).changes === 1
  );
}

export function reopenSlackOutOfScopeThread(agentGroupId: string, channelId: string, threadId: string): boolean {
  return (
    getDb()
      .prepare(
        `DELETE FROM slack_out_of_scope_threads
         WHERE agent_group_id = ? AND channel_id = ? AND thread_id = ?`,
      )
      .run(agentGroupId, channelId, threadId).changes === 1
  );
}

export function cleanupSlackOutOfScopeTestRun(testRunId: string): number {
  return getDb().prepare('DELETE FROM slack_out_of_scope_threads WHERE test_run_id = ?').run(testRunId).changes;
}
