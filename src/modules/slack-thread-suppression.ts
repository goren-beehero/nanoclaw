import type { ChannelAdapter, InboundEvent } from '../channels/adapter.js';
import {
  getSlackThreadSuppressionPolicy,
  getSlackThreadSuppressionState,
  isSlackSuppressionEventRecorded,
  pruneSlackThreadSuppressionHistory,
  recordSlackSuppressionDecision,
  saveSlackThreadSuppressionState,
  setSlackAutomaticParticipation,
  type SlackSuppressionDecision,
  type SlackThreadSuppressionPolicy,
} from '../db/slack-thread-suppression.js';
import { log } from '../log.js';

export interface SlackSuppressionInput {
  policy: SlackThreadSuppressionPolicy;
  rootUserId: string | null;
  rootHasWideMention: boolean;
  explicitMention: boolean;
  previouslyOpened: boolean;
}

export function evaluateSlackThreadSuppression(input: SlackSuppressionInput): SlackSuppressionDecision {
  if (!input.policy.enabled) return 'allow';
  if (input.rootUserId && !input.policy.suppressedRootUserIds.includes(input.rootUserId)) return 'allow';
  if (input.explicitMention) return 'allow_explicit_mention';
  if (input.previouslyOpened) return 'allow_previously_opened_thread';
  if (!input.rootUserId) return input.policy.wideMentionsOnly ? 'allow' : 'suppress_unresolved_root';
  if (input.policy.wideMentionsOnly && !input.rootHasWideMention) return 'allow';
  return input.policy.suppressedRootUserIds.includes(input.rootUserId) ? 'suppress_blacklisted_root' : 'allow';
}

export type AutomaticParticipationCommand = 'opt_out' | 'opt_in';

export function hasSlackWideMention(text: string): boolean {
  return /<!(?:channel|here|everyone)(?:\^[^>]*)?>/i.test(text);
}

function normalizeSlackDirective(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+sent using\s+@[a-z0-9_-]+\s*$/i, '')
    .replace(/<@[a-z0-9]+>/gi, ' ')
    .replace(/<!(channel|here|everyone)(?:\^[^>]*)?>/gi, ' $1 ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bsent using chatgpt\s*$/i, '')
    .trim();
}

export function parseAutomaticParticipationCommand(text: string): AutomaticParticipationCommand | null {
  const normalized = normalizeSlackDirective(text);

  if (/\bopt me out\b/.test(normalized)) return 'opt_out';
  if (
    /\bexclude me\b.*\b(?:automatic|wide|announcement|channel|here|everyone|participation|reply|replies|respond)\b/.test(
      normalized,
    ) ||
    /\b(?:do not|don't|dont|stop|disable|turn off)\b.*\b(?:automatic|automatically|participation)\b/.test(normalized)
  ) {
    return 'opt_out';
  }

  if (/\bopt me (?:back )?in\b/.test(normalized)) return 'opt_in';
  if (
    /\binclude me\b.*\b(?:automatic|wide|announcement|channel|here|everyone|participation|reply|replies|respond)\b/.test(
      normalized,
    ) ||
    /\b(?:allow|resume|enable|turn on)\b.*\b(?:automatic|automatically|participation)\b/.test(normalized)
  ) {
    return 'opt_in';
  }
  return null;
}

/**
 * A direct, message-local request for silence. Keep this deliberately narrow:
 * it must end the message, so quoted or explanatory uses of "do not reply"
 * still reach the agent. Persistent participation commands are classified
 * first and therefore never land here.
 */
export function hasOneMessageSilenceDirective(text: string): boolean {
  const normalized = normalizeSlackDirective(text);
  return (
    /\b(?:please )?(?:do not|don't|dont) (?:reply|respond)(?: to (?:me|this|this message|this thread|the thread|this announcement|the announcement))?(?: please)?$/.test(
      normalized,
    ) ||
    /\b(?:no need to (?:reply|respond)|no (?:reply|response)(?: is)? needed|(?:please )?(?:stay|remain) silent)(?: please)?$/.test(
      normalized,
    )
  );
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

function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown; raw?: { text?: unknown } };
    if (typeof parsed.raw?.text === 'string') return parsed.raw.text;
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

function participationConfirmation(command: AutomaticParticipationCommand): string {
  return command === 'opt_out'
    ? "Automatic participation is off for wide-announcement threads you start in this channel. I'll still respond when you mention me directly."
    : 'Automatic participation is on for wide-announcement threads you start in this channel. You can still mention me directly whenever you need me.';
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

  const text = messageText(event.message.content);
  const senderId = rawSlackUserId(input.resolvedSenderId);
  const participationCommand = event.message.isMention ? parseAutomaticParticipationCommand(text) : null;
  if (policy.allowSelfService && senderId && participationCommand) {
    const updated = setSlackAutomaticParticipation({
      agentGroupId,
      channelId: event.platformId,
      userId: senderId,
      optedOut: participationCommand === 'opt_out',
    });
    if (updated) {
      const decision: SlackSuppressionDecision =
        participationCommand === 'opt_out' ? 'self_service_opt_out' : 'self_service_opt_in';
      try {
        await adapter?.deliver(event.platformId, event.threadId, {
          kind: 'chat-sdk',
          content: { text: participationConfirmation(participationCommand) },
        });
      } catch (err) {
        log.error('Slack automatic-participation confirmation failed', {
          agentGroupId,
          channelId: event.platformId,
          decision,
          err,
        });
      }
      recordSlackSuppressionDecision({
        agentGroupId,
        channelId: event.platformId,
        eventId: event.message.id,
        decision,
      });
      log.info('Slack automatic-participation preference changed', {
        agentGroupId,
        channelId: event.platformId,
        decision,
      });
      return { duplicate: false, decision, suppress: true };
    }
  }

  if (policy.allowSelfService && event.message.isMention && hasOneMessageSilenceDirective(text)) {
    const decision: SlackSuppressionDecision = 'silence_requested';
    recordSlackSuppressionDecision({
      agentGroupId,
      channelId: event.platformId,
      eventId: event.message.id,
      decision,
    });
    log.info('Slack message suppressed by explicit one-message silence directive', {
      agentGroupId,
      channelId: event.platformId,
      decision,
    });
    return { duplicate: false, decision, suppress: true };
  }

  const state = getSlackThreadSuppressionState(agentGroupId, event.platformId, event.threadId);
  let rootUserId = state?.rootUserId ?? null;
  let rootHasWideMention = state?.rootHasWideMention ?? false;
  if (!rootUserId && isSlackRootMessage(event.threadId, event.message.id)) {
    rootUserId = senderId;
    rootHasWideMention = hasSlackWideMention(text);
  }
  if (!rootUserId && adapter?.resolveThreadRootMetadata) {
    try {
      const metadata = await adapter.resolveThreadRootMetadata(event.platformId, event.threadId);
      rootUserId = metadata?.userId ?? null;
      rootHasWideMention = hasSlackWideMention(metadata?.text ?? '');
    } catch (err) {
      log.warn('Slack thread root lookup failed for suppression policy', {
        agentGroupId,
        channelId: event.platformId,
        threadId: event.threadId,
        err,
      });
    }
  }
  if (!rootUserId && adapter?.resolveThreadRootUserId) {
    try {
      rootUserId = await adapter.resolveThreadRootUserId(event.platformId, event.threadId);
    } catch (err) {
      log.warn('Slack thread root author lookup failed for suppression policy', {
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
    rootHasWideMention,
    explicitMention: event.message.isMention === true,
    previouslyOpened: state?.explicitlyOpened === true,
  });
  if (rootUserId !== null) {
    const preferenceApplies =
      policy.suppressedRootUserIds.includes(rootUserId) && (!policy.wideMentionsOnly || rootHasWideMention);
    saveSlackThreadSuppressionState({
      agentGroupId,
      channelId: event.platformId,
      threadId: event.threadId,
      rootUserId,
      explicitlyOpened:
        preferenceApplies && (decision === 'allow_explicit_mention' || state?.explicitlyOpened === true),
      rootHasWideMention,
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
