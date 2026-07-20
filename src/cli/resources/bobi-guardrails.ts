import { getDb } from '../../db/connection.js';
import { cleanupKnowledgeGapTestRun } from '../../db/knowledge-gaps.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'Slack thread suppression policy',
  plural: 'slack-thread-policies',
  table: 'slack_thread_suppression_policies',
  description: 'Host-only per-agent Slack thread-root suppression policies and decision counters.',
  idColumn: 'channel_id',
  columns: [
    { name: 'agent_group_id', type: 'string', description: 'Agent group protected by this policy.' },
    { name: 'channel_id', type: 'string', description: 'Exact Slack channel ID.' },
    { name: 'enabled', type: 'boolean', description: 'Whether the policy is active.' },
    {
      name: 'suppressed_root_user_ids',
      type: 'json',
      description: 'JSON array of immutable Slack user IDs with automatic participation disabled.',
    },
    { name: 'wide_mentions_only', type: 'boolean', description: 'Apply only to Slack-wide announcements.' },
    { name: 'allow_self_service', type: 'boolean', description: 'Allow users to change their own preference.' },
    { name: 'suppressed_count', type: 'number', description: 'Suppressed blacklisted-root decisions.' },
    { name: 'explicit_mention_count', type: 'number', description: 'Explicit mention overrides.' },
    {
      name: 'previously_opened_count',
      type: 'number',
      description: 'Allowed follow-ups in explicitly opened threads.',
    },
    { name: 'unresolved_root_count', type: 'number', description: 'Fail-silent decisions when root lookup failed.' },
    { name: 'last_decision_at', type: 'string', description: 'Most recent counted decision time.' },
    { name: 'created_at', type: 'string', description: 'Creation time.' },
    { name: 'updated_at', type: 'string', description: 'Last configuration or counter update.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    set: {
      access: 'open',
      description: 'Create or replace one exact agent/channel suppression policy.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Target agent group.', required: true },
        { name: 'channel_id', type: 'string', description: 'Exact Slack channel ID.', required: true },
        {
          name: 'suppressed_root_user_ids',
          type: 'json',
          description: 'JSON array of Slack user IDs.',
          required: true,
        },
        { name: 'enabled', type: 'boolean', description: 'Enable immediately.', default: false },
        {
          name: 'wide_mentions_only',
          type: 'boolean',
          description: 'Suppress only roots containing Slack channel-wide mentions.',
          default: false,
        },
        {
          name: 'allow_self_service',
          type: 'boolean',
          description: 'Allow direct-mention opt-in and opt-out commands from the requesting user.',
          default: false,
        },
      ],
      examples: [
        'ncl slack-thread-policies set --agent-group-id ag-123 --channel-id C123 --suppressed-root-user-ids \'["U123"]\' --wide-mentions-only true --allow-self-service true --enabled false',
      ],
      async handler(args) {
        const ids = args.suppressed_root_user_ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^U[A-Z0-9]+$/.test(id))) {
          throw new Error('--suppressed-root-user-ids must be a JSON array of Slack user IDs');
        }
        const now = new Date().toISOString();
        getDb()
          .prepare(
            `INSERT INTO slack_thread_suppression_policies
               (agent_group_id, channel_id, enabled, suppressed_root_user_ids,
                wide_mentions_only, allow_self_service, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (agent_group_id, channel_id) DO UPDATE SET
               enabled = excluded.enabled,
               suppressed_root_user_ids = excluded.suppressed_root_user_ids,
               wide_mentions_only = excluded.wide_mentions_only,
               allow_self_service = excluded.allow_self_service,
               updated_at = excluded.updated_at`,
          )
          .run(
            args.agent_group_id,
            args.channel_id,
            args.enabled ? 1 : 0,
            JSON.stringify([...new Set(ids)]),
            args.wide_mentions_only ? 1 : 0,
            args.allow_self_service ? 1 : 0,
            now,
            now,
          );
        return getDb()
          .prepare(
            `SELECT * FROM slack_thread_suppression_policies
             WHERE agent_group_id = ? AND channel_id = ?`,
          )
          .get(args.agent_group_id, args.channel_id);
      },
    },
    remove: {
      access: 'open',
      description: 'Remove one exact agent/channel policy and its thread state.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Target agent group.', required: true },
        { name: 'channel_id', type: 'string', description: 'Exact Slack channel ID.', required: true },
      ],
      async handler(args) {
        const changes = getDb()
          .prepare('DELETE FROM slack_thread_suppression_policies WHERE agent_group_id = ? AND channel_id = ?')
          .run(args.agent_group_id, args.channel_id).changes;
        return { removed: changes === 1 };
      },
    },
  },
});

registerResource({
  name: 'knowledge gap',
  plural: 'knowledge-gaps',
  table: 'knowledge_gaps',
  description: 'Offline operator backlog of canonical unsupported routes, capabilities, and actions.',
  idColumn: 'fingerprint',
  columns: [
    { name: 'fingerprint', type: 'string', description: 'Deterministic canonical fingerprint.' },
    {
      name: 'category',
      type: 'string',
      description: 'Gap category.',
      enum: ['missing_route', 'missing_capability', 'unsupported_action'],
    },
    { name: 'capability_key', type: 'string', description: 'Normalized capability family.' },
    { name: 'summary', type: 'string', description: 'Operator-facing summary.' },
    { name: 'scope_boundary', type: 'string', description: 'Unavailable or unsupported boundary.' },
    { name: 'route_attempted', type: 'string', description: 'Route checked before capture.' },
    {
      name: 'status',
      type: 'string',
      description: 'Offline triage status.',
      enum: ['open', 'triaged', 'covered', 'wont_cover'],
      updatable: true,
    },
    { name: 'first_seen_at', type: 'string', description: 'First occurrence.' },
    { name: 'last_seen_at', type: 'string', description: 'Latest occurrence.' },
    { name: 'occurrence_count', type: 'number', description: 'Deduplicated event count.' },
    { name: 'example_count', type: 'number', description: 'Stored bounded examples.' },
    { name: 'examples', type: 'json', description: 'Bounded redacted examples.' },
    { name: 'test_run_id', type: 'string', description: 'Set only when every occurrence belongs to one test run.' },
  ],
  operations: { list: 'open', get: 'open', update: 'open' },
  customOperations: {
    export: {
      access: 'open',
      description: 'Export canonical gaps with occurrence metadata for offline review.',
      args: [
        {
          name: 'status',
          type: 'string',
          description: 'Optional status filter.',
          enum: ['open', 'triaged', 'covered', 'wont_cover'],
        },
      ],
      async handler(args) {
        const where = args.status ? ' WHERE status = ?' : '';
        const gaps = getDb()
          .prepare(`SELECT * FROM knowledge_gaps${where} ORDER BY last_seen_at DESC`)
          .all(...(args.status ? [args.status] : []));
        return { exported_at: new Date().toISOString(), gaps };
      },
    },
    'cleanup-test-run': {
      access: 'open',
      description: 'Remove only occurrences and scopes tagged with one validation run, then recompute canonical rows.',
      args: [{ name: 'test_run_id', type: 'string', description: 'Exact validation run ID.', required: true }],
      async handler(args) {
        return cleanupKnowledgeGapTestRun(args.test_run_id as string);
      },
    },
  },
});

registerResource({
  name: 'knowledge-gap test scope',
  plural: 'knowledge-gap-test-scopes',
  table: 'knowledge_gap_test_scopes',
  description: 'Short-lived exact channel/thread scopes used to tag and clean live validation records.',
  idColumn: 'thread_id',
  columns: [
    { name: 'channel_type', type: 'string', description: 'Channel type.' },
    { name: 'platform_id', type: 'string', description: 'Exact channel ID.' },
    { name: 'thread_id', type: 'string', description: 'Exact thread ID.' },
    { name: 'test_run_id', type: 'string', description: 'Validation run ID.' },
    { name: 'expires_at', type: 'string', description: 'Automatic expiry.' },
    { name: 'created_at', type: 'string', description: 'Creation time.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    set: {
      access: 'open',
      description: 'Tag one exact channel/thread as a temporary validation scope.',
      args: [
        { name: 'channel_type', type: 'string', description: 'Channel type.', required: true },
        { name: 'platform_id', type: 'string', description: 'Exact channel ID.', required: true },
        { name: 'thread_id', type: 'string', description: 'Exact thread ID.', required: true },
        { name: 'test_run_id', type: 'string', description: 'Validation run ID.', required: true },
        { name: 'ttl_minutes', type: 'number', description: 'Expiry in minutes.', default: 60 },
      ],
      async handler(args) {
        const ttl = Math.max(1, Math.min(24 * 60, Number(args.ttl_minutes)));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttl * 60_000).toISOString();
        getDb()
          .prepare(
            `INSERT INTO knowledge_gap_test_scopes
               (channel_type, platform_id, thread_id, test_run_id, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (channel_type, platform_id, thread_id) DO UPDATE SET
               test_run_id = excluded.test_run_id,
               expires_at = excluded.expires_at,
               created_at = excluded.created_at`,
          )
          .run(args.channel_type, args.platform_id, args.thread_id, args.test_run_id, expiresAt, now.toISOString());
        return { ...args, expires_at: expiresAt };
      },
    },
    clear: {
      access: 'open',
      description: 'Remove one exact channel/thread validation scope.',
      args: [
        { name: 'channel_type', type: 'string', description: 'Channel type.', required: true },
        { name: 'platform_id', type: 'string', description: 'Exact channel ID.', required: true },
        { name: 'thread_id', type: 'string', description: 'Exact thread ID.', required: true },
      ],
      async handler(args) {
        const changes = getDb()
          .prepare(
            `DELETE FROM knowledge_gap_test_scopes
             WHERE channel_type = ? AND platform_id = ? AND thread_id = ?`,
          )
          .run(args.channel_type, args.platform_id, args.thread_id).changes;
        return { removed: changes === 1 };
      },
    },
  },
});
