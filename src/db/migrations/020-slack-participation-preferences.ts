import type { Migration } from './index.js';

/**
 * Narrow thread suppression to channel-wide announcements and allow users to
 * manage only their own participation preference in configured channels.
 */
export const migration020: Migration = {
  version: 20,
  name: 'slack-participation-preferences',
  up(db) {
    db.exec(`
      ALTER TABLE slack_thread_suppression_policies
        ADD COLUMN wide_mentions_only INTEGER NOT NULL DEFAULT 0 CHECK (wide_mentions_only IN (0, 1));
      ALTER TABLE slack_thread_suppression_policies
        ADD COLUMN allow_self_service INTEGER NOT NULL DEFAULT 0 CHECK (allow_self_service IN (0, 1));
      ALTER TABLE slack_thread_suppression_state
        ADD COLUMN root_has_wide_mention INTEGER NOT NULL DEFAULT 0 CHECK (root_has_wide_mention IN (0, 1));
    `);
  },
};
