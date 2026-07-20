import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getKnowledgeGapTestRun, recordKnowledgeGap, type KnowledgeGapCategory } from '../../db/knowledge-gaps.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';

const categories = new Set<KnowledgeGapCategory>(['missing_route', 'missing_capability', 'unsupported_action']);

function requiredString(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`knowledge gap ${key} is required`);
  return value.trim();
}

registerDeliveryAction('record_knowledge_gap', async (content, session) => {
  const category = content.category as KnowledgeGapCategory;
  if (!categories.has(category)) throw new Error(`invalid knowledge gap category: ${String(content.category)}`);

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = mg?.channel_type ?? null;
  const platformId = mg?.platform_id ?? null;
  const threadId = session.thread_id;
  const testRunId = getKnowledgeGapTestRun(channelType, platformId, threadId);
  const sourceMessageId = typeof content.source_message_id === 'string' ? content.source_message_id : 'unknown';

  const result = recordKnowledgeGap({
    category,
    capabilityKey: requiredString(content, 'capability_key'),
    summary: requiredString(content, 'summary'),
    scopeBoundary: requiredString(content, 'scope_boundary'),
    routeAttempted: requiredString(content, 'route_attempted'),
    example: typeof content.example === 'string' ? content.example : null,
    sourceEventKey: `${session.id}:${sourceMessageId}`,
    channelType,
    platformId,
    threadId,
    testRunId,
  });
  log.info('Knowledge gap captured', {
    fingerprint: result.record.fingerprint,
    category,
    inserted: result.inserted,
    testRunId: testRunId ?? undefined,
  });
});
