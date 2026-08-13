import { describe, expect, it } from 'vitest';

import { resolveOneCliAgentIdentity, resolveOneCliParentAgentGroupId } from './onecli-agent-identity.js';

const AGENT_GROUP_ID = 'ag-1783583592620-z4xczb';
const SCOPED_GROUPS = new Set([AGENT_GROUP_ID]);

describe('resolveOneCliAgentIdentity', () => {
  it('keeps the parent identity for unscoped agent groups', () => {
    expect(resolveOneCliAgentIdentity('ag-other', 'mg-1', SCOPED_GROUPS)).toEqual({ identifier: 'ag-other' });
  });

  it('keeps the parent identity for tasks without a messaging group', () => {
    expect(resolveOneCliAgentIdentity(AGENT_GROUP_ID, null, SCOPED_GROUPS)).toEqual({
      identifier: AGENT_GROUP_ID,
    });
  });

  it('creates a stable, distinct child identity per messaging group', () => {
    const first = resolveOneCliAgentIdentity(AGENT_GROUP_ID, 'mg-ua', SCOPED_GROUPS);
    const repeated = resolveOneCliAgentIdentity(AGENT_GROUP_ID, 'mg-ua', SCOPED_GROUPS);
    const other = resolveOneCliAgentIdentity(AGENT_GROUP_ID, 'mg-testing', SCOPED_GROUPS);

    expect(first).toEqual(repeated);
    expect(first.identifier).not.toBe(other.identifier);
    expect(first.parentIdentifier).toBe(AGENT_GROUP_ID);
    expect(first.identifier).toMatch(/^ag-1783583592620-z4xczb-c-[a-f0-9]{12}$/);
  });

  it('fails closed when a scoped identifier cannot fit OneCLI limits', () => {
    const longAgentGroupId = `ag-${'x'.repeat(40)}`;
    expect(() => resolveOneCliAgentIdentity(longAgentGroupId, 'mg-ua', new Set([longAgentGroupId]))).toThrow(
      'exceeds 50 characters',
    );
  });
});

describe('resolveOneCliParentAgentGroupId', () => {
  it('maps a scoped child identity back to its parent group', () => {
    const child = resolveOneCliAgentIdentity(AGENT_GROUP_ID, 'mg-ua', SCOPED_GROUPS);
    expect(resolveOneCliParentAgentGroupId(child.identifier, SCOPED_GROUPS)).toBe(AGENT_GROUP_ID);
  });

  it('does not accept prefixes from unconfigured groups', () => {
    expect(resolveOneCliParentAgentGroupId('ag-other-c-123456789abc', SCOPED_GROUPS)).toBeUndefined();
  });
});
