import { createHash } from 'crypto';

import { CHANNEL_SCOPED_ONECLI_AGENT_GROUPS } from './config.js';

const CHANNEL_MARKER = '-c-';
const CHANNEL_HASH_LENGTH = 12;
const ONECLI_IDENTIFIER_MAX_LENGTH = 50;

export interface OneCliAgentIdentity {
  identifier: string;
  parentIdentifier?: string;
}

/**
 * Resolve the credential identity used by OneCLI for a container session.
 * Scoped children inherit the parent's non-sensitive credentials, while
 * OneCLI can grant channel-specific connections to the child identity.
 */
export function resolveOneCliAgentIdentity(
  agentGroupId: string,
  messagingGroupId: string | null,
  scopedAgentGroupIds: ReadonlySet<string> = CHANNEL_SCOPED_ONECLI_AGENT_GROUPS,
): OneCliAgentIdentity {
  if (!messagingGroupId || !scopedAgentGroupIds.has(agentGroupId)) {
    return { identifier: agentGroupId };
  }

  const channelHash = createHash('sha256').update(messagingGroupId).digest('hex').slice(0, CHANNEL_HASH_LENGTH);
  const identifier = `${agentGroupId}${CHANNEL_MARKER}${channelHash}`;
  if (identifier.length > ONECLI_IDENTIFIER_MAX_LENGTH) {
    throw new Error(
      `Channel-scoped OneCLI identifier exceeds ${ONECLI_IDENTIFIER_MAX_LENGTH} characters for agent group ${agentGroupId}`,
    );
  }

  return { identifier, parentIdentifier: agentGroupId };
}

/** Map a channel-scoped OneCLI child identifier back to its NanoClaw agent group. */
export function resolveOneCliParentAgentGroupId(
  identifier: string,
  scopedAgentGroupIds: ReadonlySet<string> = CHANNEL_SCOPED_ONECLI_AGENT_GROUPS,
): string | undefined {
  for (const agentGroupId of scopedAgentGroupIds) {
    if (identifier.startsWith(`${agentGroupId}${CHANNEL_MARKER}`)) return agentGroupId;
  }
  return undefined;
}
