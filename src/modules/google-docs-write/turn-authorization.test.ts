import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearGoogleDocsWriteTurnsForTest,
  consumeGoogleDocsWriteTurn,
  recordGoogleDocsWriteTurn,
} from './turn-authorization.js';

const allowed = new Set(['slack:U-OWNER']);

afterEach(() => {
  clearGoogleDocsWriteTurnsForTest();
  vi.useRealTimers();
});

describe('Google Docs write turn authorization', () => {
  it('allows the exact newest owner message once', () => {
    recordGoogleDocsWriteTurn('sess-1', 'msg-owner', 'slack:U-OWNER');
    expect(consumeGoogleDocsWriteTurn('sess-1', 'msg-owner', allowed)).toEqual({
      allowed: true,
      userId: 'slack:U-OWNER',
    });
    expect(consumeGoogleDocsWriteTurn('sess-1', 'msg-owner', allowed)).toMatchObject({ allowed: false });
  });

  it('replaces an owner grant when a different sender posts next', () => {
    recordGoogleDocsWriteTurn('sess-1', 'msg-owner', 'slack:U-OWNER');
    recordGoogleDocsWriteTurn('sess-1', 'msg-other', 'slack:U-OTHER');
    expect(consumeGoogleDocsWriteTurn('sess-1', 'msg-owner', allowed)).toMatchObject({
      allowed: false,
      code: 'stale_message',
      reason: expect.stringContaining('newest'),
    });
    expect(consumeGoogleDocsWriteTurn('sess-1', 'msg-other', allowed)).toMatchObject({
      allowed: false,
      code: 'unauthorized_sender',
      reason: expect.stringContaining('not authorized'),
    });
  });

  it('expires an unused grant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    recordGoogleDocsWriteTurn('sess-1', 'msg-owner', 'slack:U-OWNER');
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(consumeGoogleDocsWriteTurn('sess-1', 'msg-owner', allowed)).toMatchObject({
      allowed: false,
      code: 'expired_turn',
      reason: expect.stringContaining('expired'),
    });
  });
});
