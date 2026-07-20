import type { ChannelAdapter, InboundEvent } from '../channels/adapter.js';
import {
  getSlackThreadSuppressionPolicy,
  getSlackThreadSuppressionState,
  isSlackSuppressionEventRecorded,
  pruneSlackThreadSuppressionHistory,
  recordSlackSuppressionDecision,
  saveSlackThreadSuppressionState,
  type SlackSuppressionDecision,
  type SlackThreadSuppressionPolicy,
} from '../db/slack-thread-suppression.js';
import { log } from '../log.js';

export interface SlackSuppressionInput {
  policy: SlackThreadSuppressionPolicy;
  rootUserId: string | null;
  explicitMention: boolean;
  previouslyOpened: boolean;
}

export function evaluateSlackThreadSuppression(input: SlackSuppressionInput): SlackSuppressionDecision {
  if (!input.policy.enabled) return 'allow';
  if (input.rootUserId && !input.policy.suppressedRootUserIds.includes(input.rootUserId)) return 'allow';
  if (input.explicitMention) return 'allow_explicit_mention';
  if (input.previouslyOpened) return 'allow_previously_opened_thread';
  if (!input.rootUserId) return 'suppress_unresolved_root';
  return input.policy.suppressedRootUserIds.includes(input.rootUserId) ? 'suppress_blacklisted_root' : 'allow';
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPrunedAt = 0;

function maybePruneSuppressionHistory(): void {
  const now = Date.now();
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  pruneSlackThreadSuppressionHistory(new Date(now));
}

function rawSlackUserId(userId: string | null): string | null {
  if (!userId) return null;
  return userId.startsWith('slack:') ? userId.slice('slack:'.length) : userId;
}

function isSlackRootMessage(threadId: string, messageId: string): boolean {
  return threadId === messageId || threadId.endsWith(`:${messageId}`);
}

export interface SlackSuppressionResolution {
  duplicate: boolean;
  decision: SlackSuppressionDecision;
  suppress: boolean;
}

export async function resolveSlackThreadSuppression(input: {
  event: InboundEvent;
  agentGroupId: string;
  resolvedSenderId: string | null;
  adapter: ChannelAdapter | undefined;
}): Promise<SlackSuppressionResolution> {
  const { event, agentGroupId, adapter } = input;
  if (event.channelType !== 'slack' || event.threadId === null) {
    return { duplicate: false, decision: 'allow', suppress: false };
  }

  const policy = getSlackThreadSuppressionPolicy(agentGroupId, event.platformId);
  if (!policy?.enabled) return { duplicate: false, decision: 'allow', suppress: false };
  maybePruneSuppressionHistory();

  if (isSlackSuppressionEventRecorded(agentGroupId, event.platformId, event.message.id)) {
    return { duplicate: true, decision: 'allow', suppress: true };
  }

  const state = getSlackThreadSuppressionState(agentGroupId, event.platformId, event.threadId);
  let rootUserId = state?.rootUserId ?? null;
  if (!rootUserId && isSlackRootMessage(event.threadId, event.message.id)) {
    rootUserId = rawSlackUserId(input.resolvedSenderId);
  }
  if (!rootUserId && adapter?.resolveThreadRootUserId) {
    try {
      rootUserId = await adapter.resolveThreadRootUserId(event.platformId, event.threadId);
    } catch (err) {
      log.warn('Slack thread root lookup failed for suppression policy', {
        agentGroupId,
        channelId: event.platformId,
        threadId: event.threadId,
        err,
      });
    }
  }

  const decision = evaluateSlackThreadSuppression({
    policy,
    rootUserId,
    explicitMention: event.message.isMention === true,
    previouslyOpened: state?.explicitlyOpened === true,
  });
  if (rootUserId !== null) {
    const blacklisted = policy.suppressedRootUserIds.includes(rootUserId);
    saveSlackThreadSuppressionState({
      agentGroupId,
      channelId: event.platformId,
      threadId: event.threadId,
      rootUserId,
      explicitlyOpened: blacklisted && (decision === 'allow_explicit_mention' || state?.explicitlyOpened === true),
    });
  }

  recordSlackSuppressionDecision({
    agentGroupId,
    channelId: event.platformId,
    eventId: event.message.id,
    decision,
  });
  const suppress = decision === 'suppress_blacklisted_root' || decision === 'suppress_unresolved_root';
  log.info('Slack thread suppression decision', {
    agentGroupId,
    channelId: event.platformId,
    decision,
    suppress,
  });
  return { duplicate: false, decision, suppress };
}
