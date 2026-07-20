import { describe, expect, it } from 'vitest';

import { evaluateSlackThreadSuppression } from './slack-thread-suppression.js';

const policy = {
  agentGroupId: 'ag-bobi',
  channelId: 'C-AUS',
  enabled: true,
  suppressedRootUserIds: ['U-REECE'],
};

describe('evaluateSlackThreadSuppression', () => {
  it.each([
    ['U-REECE', false, false, 'suppress_blacklisted_root'],
    ['U-REECE', true, false, 'allow_explicit_mention'],
    ['U-REECE', false, true, 'allow_previously_opened_thread'],
    ['U-OTHER', false, false, 'allow'],
    ['U-OTHER', true, false, 'allow'],
    [null, false, false, 'suppress_unresolved_root'],
  ] as const)('root=%s mention=%s opened=%s => %s', (rootUserId, explicitMention, previouslyOpened, expected) => {
    expect(evaluateSlackThreadSuppression({ policy, rootUserId, explicitMention, previouslyOpened })).toBe(expected);
  });

  it('preserves existing behavior while disabled', () => {
    expect(
      evaluateSlackThreadSuppression({
        policy: { ...policy, enabled: false },
        rootUserId: 'U-REECE',
        explicitMention: false,
        previouslyOpened: false,
      }),
    ).toBe('allow');
  });
});
