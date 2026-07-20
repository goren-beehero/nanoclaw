import { describe, expect, it } from 'vitest';

import {
  evaluateSlackThreadSuppression,
  hasOneMessageSilenceDirective,
  hasSlackWideMention,
  parseAutomaticParticipationCommand,
} from './slack-thread-suppression.js';

const policy = {
  agentGroupId: 'ag-bobi',
  channelId: 'C-AUS',
  enabled: true,
  suppressedRootUserIds: ['U-REECE'],
  wideMentionsOnly: false,
  allowSelfService: false,
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
    expect(
      evaluateSlackThreadSuppression({
        policy,
        rootUserId,
        rootHasWideMention: false,
        explicitMention,
        previouslyOpened,
      }),
    ).toBe(expected);
  });

  it('preserves existing behavior while disabled', () => {
    expect(
      evaluateSlackThreadSuppression({
        policy: { ...policy, enabled: false },
        rootUserId: 'U-REECE',
        rootHasWideMention: true,
        explicitMention: false,
        previouslyOpened: false,
      }),
    ).toBe('allow');
  });

  it.each([
    [true, false, false, 'suppress_blacklisted_root'],
    [false, false, false, 'allow'],
    [true, true, false, 'allow_explicit_mention'],
    [true, false, true, 'allow_previously_opened_thread'],
  ] as const)(
    'wide-only rootWide=%s mention=%s opened=%s => %s',
    (rootHasWideMention, explicitMention, previouslyOpened, expected) => {
      expect(
        evaluateSlackThreadSuppression({
          policy: { ...policy, wideMentionsOnly: true },
          rootUserId: 'U-REECE',
          rootHasWideMention,
          explicitMention,
          previouslyOpened,
        }),
      ).toBe(expected);
    },
  );

  it('does not suppress unresolved roots under a wide-announcement-only policy', () => {
    expect(
      evaluateSlackThreadSuppression({
        policy: { ...policy, wideMentionsOnly: true },
        rootUserId: null,
        rootHasWideMention: false,
        explicitMention: false,
        previouslyOpened: false,
      }),
    ).toBe('allow');
  });
});

describe('Slack automatic-participation commands', () => {
  it.each([
    ['<@U-BOBI> opt me out', 'opt_out'],
    ["<@U-BOBI> don't automatically reply to my <!channel> announcements", 'opt_out'],
    ['<@U-BOBI> exclude me from wide announcement replies', 'opt_out'],
    ['<@U-BOBI> opt me back in', 'opt_in'],
    ['<@U-BOBI> include me in automatic announcement replies', 'opt_in'],
    ['<@U-BOBI> resume automatic participation', 'opt_in'],
    ['<@U-BOBI> do not reply', null],
    ['<!channel> change notice <@U-BOBI> please do not respond', null],
    ['<!channel> my announcement about the change <@U-BOBI> do not reply', null],
    ['<@U-BOBI> do not reply Sent using @ChatGPT', null],
    ['<@U-BOBI> what is the AUS group status?', null],
  ] as const)('parses %j as %s', (text, expected) => {
    expect(parseAutomaticParticipationCommand(text)).toBe(expected);
  });

  it.each([
    ['<@U-BOBI> do not reply', true],
    ["<!channel> rollout note <@U-BOBI> please don't respond", true],
    ['<@U-BOBI> this is FYI only, no response needed', true],
    ['<@U-BOBI> no need to reply', true],
    ['<@U-BOBI> dont reply', true],
    ['<@U-BOBI> do not reply Sent using @ChatGPT', true],
    ['<@U-BOBI> please remain silent', true],
    ["<@U-BOBI> don't automatically reply to my <!channel> announcements", false],
    ['<@U-BOBI> explain why the phrase do not reply appears here', false],
    ['<@U-BOBI> explain why do not reply is quoted Sent using @ChatGPT', false],
    ['<@U-BOBI> do not reply with a guess; inspect the data instead', false],
    ['<@U-BOBI> what is the AUS group status?', false],
  ] as const)('classifies one-message silence in %j as %s', (text, expected) => {
    expect(hasOneMessageSilenceDirective(text)).toBe(expected);
  });

  it.each([
    ['<!channel> update', true],
    ['<!here> update', true],
    ['<!everyone> update', true],
    ['@channel typed literally', false],
    ['ordinary update', false],
  ] as const)('detects Slack-resolved wide mention in %j', (text, expected) => {
    expect(hasSlackWideMention(text)).toBe(expected);
  });
});
