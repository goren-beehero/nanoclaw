import type { Migration } from './index.js';

/**
 * Persist Slack threads that the agent has explicitly classified as out of
 * scope. The host consumes later unmentioned replies before they reach a
 * session; a direct mention reopens the thread.
 */
export const migration021: Migration = {
  version: 21,
  name: 'slack-out-of-scope-threads',
  up(db) {
    db.exec(`
      CREATE TABLE slack_out_of_scope_threads (
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        knowledge_gap_fingerprint TEXT NOT NULL,
        source_event_key TEXT NOT NULL,
        test_run_id TEXT,
        suppressed_count INTEGER NOT NULL DEFAULT 0,
        last_suppressed_message_id TEXT,
        last_suppressed_at TEXT,
        closed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, channel_id, thread_id)
      );
      CREATE INDEX idx_slack_out_of_scope_threads_updated
        ON slack_out_of_scope_threads(updated_at);
      CREATE INDEX idx_slack_out_of_scope_threads_test_run
        ON slack_out_of_scope_threads(test_run_id);
    `);
  },
};
