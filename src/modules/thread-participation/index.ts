import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';

function exactString(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`disengage_thread ${key} is required`);
  return value;
}

registerDeliveryAction(
  'disengage_thread',
  async (content, session) => {
    if (!session.messaging_group_id || !session.thread_id) {
      throw new Error('disengage_thread requires a channel-backed threaded session');
    }
    const mg = getMessagingGroup(session.messaging_group_id);
    if (!mg) throw new Error(`messaging group ${session.messaging_group_id} not found`);

    const channelType = exactString(content, 'channel_type');
    const platformId = exactString(content, 'platform_id');
    const threadId = exactString(content, 'thread_id');
    const reason = exactString(content, 'reason');
    if (reason !== 'task_complete' && reason !== 'human_requested') {
      throw new Error('disengage_thread reason is invalid');
    }
    if (channelType !== mg.channel_type || platformId !== mg.platform_id || threadId !== session.thread_id) {
      throw new Error('disengage_thread route does not match its originating session');
    }

    const adapter = getDeliveryAdapter();
    if (!adapter?.unsubscribe) throw new Error('active channel adapter does not support thread disengagement');
    await adapter.unsubscribe(channelType, platformId, threadId, mg.instance);
    log.info('Agent disengaged from thread', {
      sessionId: session.id,
      channelType,
      platformId,
      threadId,
      reason,
    });
  },
  unguarded('reversible current-thread subscription bookkeeping; a direct mention re-engages'),
);
