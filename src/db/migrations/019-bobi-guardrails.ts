import type { Migration } from './index.js';

/**
 * Bobi guardrails are host-owned state. Neither table family is mounted into
 * agent containers: Slack suppression is decided before session creation and
 * knowledge gaps are captured from an internal outbound event.
 */
export const migration019: Migration = {
  version: 19,
  name: 'bobi-guardrails',
  up(db) {
    db.exec(`
      CREATE TABLE slack_thread_suppression_policies (
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        suppressed_root_user_ids TEXT NOT NULL DEFAULT '[]',
        suppressed_count INTEGER NOT NULL DEFAULT 0,
        explicit_mention_count INTEGER NOT NULL DEFAULT 0,
        previously_opened_count INTEGER NOT NULL DEFAULT 0,
        unresolved_root_count INTEGER NOT NULL DEFAULT 0,
        last_decision_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, channel_id)
      );

      CREATE TABLE slack_thread_suppression_state (
        agent_group_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        root_user_id TEXT NOT NULL,
        explicitly_opened INTEGER NOT NULL DEFAULT 0 CHECK (explicitly_opened IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, channel_id, thread_id),
        FOREIGN KEY (agent_group_id, channel_id)
          REFERENCES slack_thread_suppression_policies(agent_group_id, channel_id)
          ON DELETE CASCADE
      );
      CREATE INDEX idx_slack_suppression_state_updated
        ON slack_thread_suppression_state(updated_at);

      CREATE TABLE slack_thread_suppression_events (
        agent_group_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, channel_id, event_id),
        FOREIGN KEY (agent_group_id, channel_id)
          REFERENCES slack_thread_suppression_policies(agent_group_id, channel_id)
          ON DELETE CASCADE
      );
      CREATE INDEX idx_slack_suppression_events_decided
        ON slack_thread_suppression_events(decided_at);

      CREATE TABLE knowledge_gaps (
        fingerprint TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('missing_route', 'missing_capability', 'unsupported_action')),
        capability_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        scope_boundary TEXT NOT NULL,
        route_attempted TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'covered', 'wont_cover')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        example_count INTEGER NOT NULL DEFAULT 0,
        examples TEXT NOT NULL DEFAULT '[]',
        test_run_id TEXT
      );
      CREATE INDEX idx_knowledge_gaps_status_last_seen
        ON knowledge_gaps(status, last_seen_at);

      CREATE TABLE knowledge_gap_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL REFERENCES knowledge_gaps(fingerprint) ON DELETE CASCADE,
        source_event_key TEXT NOT NULL UNIQUE,
        seen_at TEXT NOT NULL,
        channel_type TEXT,
        platform_id TEXT,
        thread_id TEXT,
        example TEXT,
        test_run_id TEXT
      );
      CREATE INDEX idx_knowledge_gap_occurrences_fingerprint
        ON knowledge_gap_occurrences(fingerprint, seen_at);
      CREATE INDEX idx_knowledge_gap_occurrences_test_run
        ON knowledge_gap_occurrences(test_run_id);

      CREATE TABLE knowledge_gap_test_scopes (
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        test_run_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id, thread_id)
      );
      CREATE INDEX idx_knowledge_gap_test_scopes_expiry
        ON knowledge_gap_test_scopes(expires_at);
    `);
  },
};
