import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  setMessagingGroupDeniedAt,
} from '../../db/messaging-groups.js';
import { authorizeInboundMedia } from '../../router.js';
import { addMember } from './db/agent-group-members.js';

function now(): string {
  return new Date().toISOString();
}

function mediaEvent(platformId: string, sender: string): InboundEvent {
  const isGroup = platformId.endsWith('@g.us');
  return {
    channelType: 'whatsapp',
    instance: 'whatsapp',
    platformId,
    threadId: null,
    message: {
      id: `media-${platformId}`,
      kind: 'chat',
      content: JSON.stringify({ text: '', sender, senderName: 'WhatsApp sender' }),
      timestamp: now(),
      isMention: true,
      isGroup,
    },
  };
}

async function seedWiring(
  platformId: string,
  policy: 'request_approval' | 'public',
  senderScope: 'all' | 'known' = 'all',
): Promise<void> {
  const isGroup = platformId.endsWith('@g.us');
  await createMessagingGroup({
    id: `mg-${policy}`,
    channel_type: 'whatsapp',
    platform_id: platformId,
    instance: 'whatsapp',
    name: isGroup ? 'WhatsApp group' : 'WhatsApp DM',
    is_group: isGroup ? 1 : 0,
    unknown_sender_policy: policy,
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: `mga-${policy}`,
    messaging_group_id: `mg-${policy}`,
    agent_group_id: 'ag-bobi',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: senderScope,
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await import('./index.js');
  await createAgentGroup({
    id: 'ag-bobi',
    name: 'Bobi',
    folder: 'bobi',
    agent_provider: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('inbound media authorization', () => {
  it('denies media for a completely unknown WhatsApp DM', async () => {
    await expect(
      authorizeInboundMedia(mediaEvent('15550000001@s.whatsapp.net', '15550000001@s.whatsapp.net')),
    ).resolves.toBe(false);
  });

  it('denies a request-approval sender until membership exists, then admits them', async () => {
    const platformId = '15550000002@s.whatsapp.net';
    const sender = '15550000002@s.whatsapp.net';
    await seedWiring(platformId, 'request_approval');

    await expect(authorizeInboundMedia(mediaEvent(platformId, sender))).resolves.toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM unregistered_senders').get()).toEqual({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM pending_sender_approvals').get()).toEqual({ n: 0 });

    await addMember({
      user_id: `whatsapp:${sender}`,
      agent_group_id: 'ag-bobi',
      added_by: null,
      added_at: now(),
    });
    await expect(authorizeInboundMedia(mediaEvent(platformId, sender))).resolves.toBe(true);
  });

  it('admits media in an intentionally public/all conversation', async () => {
    const platformId = '120363000000000000@g.us';
    await seedWiring(platformId, 'public');

    await expect(authorizeInboundMedia(mediaEvent(platformId, '15550000003@s.whatsapp.net'))).resolves.toBe(true);
  });

  it('keeps a public conversation fail-closed when the wiring is known-senders only', async () => {
    const platformId = '120363000000000001@g.us';
    const sender = '15550000004@s.whatsapp.net';
    await seedWiring(platformId, 'public', 'known');

    await expect(authorizeInboundMedia(mediaEvent(platformId, sender))).resolves.toBe(false);
    await addMember({
      user_id: `whatsapp:${sender}`,
      agent_group_id: 'ag-bobi',
      added_by: null,
      added_at: now(),
    });
    await expect(authorizeInboundMedia(mediaEvent(platformId, sender))).resolves.toBe(true);
  });

  it('denies media for a denied conversation even if it still has a wiring', async () => {
    const platformId = '15550000005@s.whatsapp.net';
    await seedWiring(platformId, 'public');
    setMessagingGroupDeniedAt('mg-public', now());

    await expect(authorizeInboundMedia(mediaEvent(platformId, platformId))).resolves.toBe(false);
  });
});
