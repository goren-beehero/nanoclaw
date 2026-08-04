import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { findSessionForAgent } from './db/sessions.js';
import { getDeliveryAction } from './delivery.js';
import { inboundDbPath } from './session-manager.js';
import type { InboundEvent } from './channels/adapter.js';
import './modules/knowledge-gaps/index.js';

const { TEST_DIR, deliver, resolveThreadRootMetadata, resolveThreadRootUserId } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-slack-suppression-test',
  deliver: vi.fn<(platformId: string, threadId: string | null, message: unknown) => Promise<string | undefined>>(),
  resolveThreadRootMetadata: vi.fn<() => Promise<{ userId: string; text: string } | null>>(),
  resolveThreadRootUserId: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelDefaults: vi.fn(() => ({
    dm: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'strict' },
    group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public' },
    mentions: 'platform',
  })),
  getChannelAdapter: vi.fn(() => ({
    name: 'slack',
    channelType: 'slack',
    supportsThreads: true,
    deliver,
    resolveThreadRootMetadata,
    resolveThreadRootUserId,
  })),
}));

function now(): string {
  return new Date().toISOString();
}

function event(
  id: string,
  threadId: string,
  mention = false,
  channel = 'C-TEST',
  text = mention ? '<@U-BOBI> help' : 'ambient question',
  senderId = 'U-SENDER',
  threadSubscribed = false,
): InboundEvent {
  return {
    channelType: 'slack',
    platformId: channel,
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ senderId, text, raw: { text } }),
      timestamp: now(),
      isMention: mention,
      isThreadSubscribed: threadSubscribed,
      isGroup: true,
    },
  };
}

beforeAll(async () => {
  const { setSenderResolver } = await import('./router.js');
  setSenderResolver((inbound) => {
    const parsed = JSON.parse(inbound.message.content) as { senderId?: unknown };
    return typeof parsed.senderId === 'string' ? `slack:${parsed.senderId}` : null;
  });
});

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-bobi',
    name: 'Bobi',
    folder: 'bobi',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-test',
    channel_type: 'slack',
    platform_id: 'C-TEST',
    name: 'bobi-testing',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-test',
    messaging_group_id: 'mg-test',
    agent_group_id: 'ag-bobi',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now(),
  });
  getDb()
    .prepare(
      `INSERT INTO slack_thread_suppression_policies
         (agent_group_id, channel_id, enabled, suppressed_root_user_ids, created_at, updated_at)
       VALUES ('ag-bobi', 'C-TEST', 1, '["U-BLACKLISTED"]', ?, ?)`,
    )
    .run(now(), now());
  resolveThreadRootUserId.mockReset();
  resolveThreadRootMetadata.mockReset();
  deliver.mockReset().mockResolvedValue('confirmation-1');
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
});

describe('Slack suppression router integration', () => {
  it('suppresses before session creation, typing, and wake', async () => {
    resolveThreadRootUserId.mockResolvedValue('U-BLACKLISTED');
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const typing = await import('./modules/typing/index.js');

    await routeInbound(event('100.1', 'slack:C-TEST:100.1', false, 'C-TEST', 'ambient question', 'U-BLACKLISTED'));

    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:100.1')).toBeUndefined();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(typing.startTypingRefresh).not.toHaveBeenCalled();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_gaps').get() as { n: number }).n).toBe(0);
  });

  it('keeps replies by other users suppressed when the root is blacklisted', async () => {
    resolveThreadRootUserId.mockResolvedValue('U-BLACKLISTED');
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('200.1', 'slack:C-TEST:200.1', false, 'C-TEST', 'ambient question', 'U-BLACKLISTED'));
    await routeInbound(event('200.2', 'slack:C-TEST:200.1', false, 'C-TEST', 'follow-up', 'U-OTHER'));
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:200.1')).toBeUndefined();
  });

  it('allows a resolved mention and ordinary follow-up in the same thread exactly once', async () => {
    resolveThreadRootUserId.mockResolvedValue('U-BLACKLISTED');
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(event('300.1', 'slack:C-TEST:300.1', true, 'C-TEST', '<@U-BOBI> help', 'U-BLACKLISTED'));
    await routeInbound(event('300.2', 'slack:C-TEST:300.1', false));
    await routeInbound(event('300.2', 'slack:C-TEST:300.1', false));

    const session = findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:300.1');
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-bobi', session!.id));
    const rows = db.prepare('SELECT id, platform_id, thread_id FROM messages_in ORDER BY seq').all() as {
      id: string;
      platform_id: string;
      thread_id: string;
    }[];
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.platform_id === 'C-TEST')).toBe(true);
    expect(rows.every((row) => row.thread_id === 'slack:C-TEST:300.1')).toBe(true);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('does not suppress a blacklisted reply inside another user root thread', async () => {
    resolveThreadRootUserId.mockResolvedValue('U-OTHER');
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('400.2', 'slack:C-TEST:400.1'));
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:400.1')).toBeDefined();
  });

  it('fails silent when root metadata cannot be resolved', async () => {
    resolveThreadRootUserId.mockResolvedValue(null);
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('500.2', 'slack:C-TEST:500.1'));
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:500.1')).toBeUndefined();
  });

  it('does not change behavior in another channel', async () => {
    createMessagingGroup({
      id: 'mg-other',
      channel_type: 'slack',
      platform_id: 'C-OTHER',
      name: 'other',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-other',
      messaging_group_id: 'mg-other',
      agent_group_id: 'ag-bobi',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    resolveThreadRootUserId.mockResolvedValue('U-BLACKLISTED');
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('600.1', 'slack:C-OTHER:600.1', false, 'C-OTHER'));
    expect(findSessionForAgent('ag-bobi', 'mg-other', 'slack:C-OTHER:600.1')).toBeDefined();
  });

  it('keeps a subscribed thread routable after recording a knowledge gap', async () => {
    getDb()
      .prepare(
        `UPDATE messaging_group_agents
         SET engage_mode = 'mention-sticky', engage_pattern = NULL
         WHERE id = 'mga-test'`,
      )
      .run();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const threadId = 'slack:C-TEST:610.1';

    await routeInbound(event('610.1', threadId, true, 'C-TEST', '<@U-BOBI> check this', 'U-GUY'));
    const session = findSessionForAgent('ag-bobi', 'mg-test', threadId);
    expect(session).toBeDefined();
    const handler = getDeliveryAction('record_knowledge_gap');
    expect(handler).toBeDefined();
    const inDb = new Database(inboundDbPath('ag-bobi', session!.id));
    await handler!(
      {
        action: 'record_knowledge_gap',
        category: 'missing_capability',
        capability_key: 'aircall action-item summaries',
        summary: 'Structured call action items are unavailable',
        scope_boundary: 'Conversation analysis only',
        route_attempted: 'Aircall read-only connector',
        source_message_id: '610.1',
      },
      session!,
      inDb,
    );
    inDb.close();
    vi.mocked(wakeContainer).mockClear();

    await routeInbound(event('610.2', threadId, false, 'C-TEST', 'Try the last three calls instead.', 'U-GUY', true));

    const db = new Database(inboundDbPath('ag-bobi', session!.id));
    const messages = db.prepare('SELECT id FROM messages_in ORDER BY seq').all();
    db.close();
    expect(messages).toHaveLength(2);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_gaps').get() as { n: number }).n).toBe(1);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM slack_out_of_scope_threads').get() as { n: number }).n).toBe(0);
  });

  it('lets a user opt out and back in while limiting suppression to wide announcements', async () => {
    getDb()
      .prepare(
        `UPDATE slack_thread_suppression_policies
         SET suppressed_root_user_ids = '[]', wide_mentions_only = 1, allow_self_service = 1
         WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'`,
      )
      .run();
    const { routeInbound } = await import('./router.js');

    const optOut = event(
      '700.1',
      'slack:C-TEST:700.1',
      true,
      'C-TEST',
      '<@U-BOBI> opt me out of automatic participation',
      'U-GUY',
    );
    await routeInbound(optOut);
    await routeInbound(optOut);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toBe('C-TEST');
    expect(deliver.mock.calls[0]?.[1]).toBe('slack:C-TEST:700.1');
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:700.1')).toBeUndefined();
    const optedOut = getDb()
      .prepare(
        `SELECT suppressed_root_user_ids FROM slack_thread_suppression_policies
         WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'`,
      )
      .get() as { suppressed_root_user_ids: string };
    expect(JSON.parse(optedOut.suppressed_root_user_ids)).toEqual(['U-GUY']);

    await routeInbound(event('710.1', 'slack:C-TEST:710.1', false, 'C-TEST', '<!channel> operations update', 'U-GUY'));
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:710.1')).toBeUndefined();

    await routeInbound(event('720.1', 'slack:C-TEST:720.1', false, 'C-TEST', 'ordinary question', 'U-GUY'));
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:720.1')).toBeDefined();

    await routeInbound(
      event('730.1', 'slack:C-TEST:730.1', true, 'C-TEST', '<!channel> <@U-BOBI> please check this update', 'U-GUY'),
    );
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:730.1')).toBeDefined();

    await routeInbound(event('740.1', 'slack:C-TEST:740.1', true, 'C-TEST', '<@U-BOBI> opt me back in', 'U-GUY'));
    expect(deliver).toHaveBeenCalledTimes(2);
    const optedIn = getDb()
      .prepare(
        `SELECT suppressed_root_user_ids FROM slack_thread_suppression_policies
         WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'`,
      )
      .get() as { suppressed_root_user_ids: string };
    expect(JSON.parse(optedIn.suppressed_root_user_ids)).toEqual([]);

    await routeInbound(
      event('750.1', 'slack:C-TEST:750.1', false, 'C-TEST', '<!here> another operations update', 'U-GUY'),
    );
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:750.1')).toBeDefined();
  });

  it.each([
    '<@U-BOBI> do not reply',
    '<@U-BOBI> policy note; do not reply Sent using @ChatGPT',
    '<!channel> policy note; please do not respond to this announcement **Sent using** @ChatGPT',
    "<!channel> participation policy update <@U-BOBI> please don't respond",
    '<!here> FYI <@U-BOBI> no response needed',
    '<@U-BOBI> no need to reply',
    '<@U-BOBI> please remain silent',
  ])('silences only the current message without changing participation for %j', async (text) => {
    getDb()
      .prepare(
        `UPDATE slack_thread_suppression_policies
         SET suppressed_root_user_ids = '["U-EXISTING"]', wide_mentions_only = 1, allow_self_service = 1
         WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'`,
      )
      .run();
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const typing = await import('./modules/typing/index.js');
    const id = `800.${text.length}`;
    const threadId = `slack:C-TEST:${id}`;

    const silence = event(id, threadId, true, 'C-TEST', text, 'U-GUY');
    await routeInbound(silence);
    await routeInbound(silence);

    expect(deliver).not.toHaveBeenCalled();
    expect(findSessionForAgent('ag-bobi', 'mg-test', threadId)).toBeUndefined();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(typing.startTypingRefresh).not.toHaveBeenCalled();
    const policyRow = getDb()
      .prepare(
        `SELECT suppressed_root_user_ids FROM slack_thread_suppression_policies
         WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'`,
      )
      .get() as { suppressed_root_user_ids: string };
    expect(JSON.parse(policyRow.suppressed_root_user_ids)).toEqual(['U-EXISTING']);
    expect(
      (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM slack_thread_suppression_events
             WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'
               AND event_id = ? AND decision = 'silence_requested'`,
          )
          .get(id) as { n: number }
      ).n,
    ).toBe(1);
  });

  it('keeps ordinary direct mentions and quoted no-reply language working normally', async () => {
    getDb()
      .prepare(
        `UPDATE slack_thread_suppression_policies
         SET suppressed_root_user_ids = '[]', wide_mentions_only = 1, allow_self_service = 1
         WHERE agent_group_id = 'ag-bobi' AND channel_id = 'C-TEST'`,
      )
      .run();
    const { routeInbound } = await import('./router.js');

    await routeInbound(
      event(
        '900.1',
        'slack:C-TEST:900.1',
        true,
        'C-TEST',
        '<@U-BOBI> explain why the phrase do not reply appears in the policy',
        'U-GUY',
      ),
    );
    await routeInbound(
      event('910.1', 'slack:C-TEST:910.1', true, 'C-TEST', '<@U-BOBI> check the AUS group status', 'U-GUY'),
    );

    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:900.1')).toBeDefined();
    expect(findSessionForAgent('ag-bobi', 'mg-test', 'slack:C-TEST:910.1')).toBeDefined();
    expect(deliver).not.toHaveBeenCalled();
  });
});
