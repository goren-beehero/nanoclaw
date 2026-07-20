import type { InboundEvent } from '../channels/adapter.js';
import { getSlackOutOfScopeThread, suppressSlackOutOfScopeThreadReply } from '../db/slack-out-of-scope-threads.js';
import { log } from '../log.js';

export interface SlackOutOfScopeResolution {
  suppress: boolean;
  reopenRequested: boolean;
}

export function resolveSlackOutOfScopeThread(input: {
  event: InboundEvent;
  agentGroupId: string;
}): SlackOutOfScopeResolution {
  const { event, agentGroupId } = input;
  if (event.channelType !== 'slack' || event.threadId === null) {
    return { suppress: false, reopenRequested: false };
  }

  const closed = getSlackOutOfScopeThread(agentGroupId, event.platformId, event.threadId);
  if (!closed) return { suppress: false, reopenRequested: false };

  if (event.message.isMention === true) {
    return { suppress: false, reopenRequested: true };
  }

  suppressSlackOutOfScopeThreadReply({
    agentGroupId,
    channelId: event.platformId,
    threadId: event.threadId,
    messageId: event.message.id,
  });
  log.info('Slack follow-up suppressed for out-of-scope thread', {
    agentGroupId,
    channelId: event.platformId,
    threadId: event.threadId,
  });
  return { suppress: true, reopenRequested: false };
}
