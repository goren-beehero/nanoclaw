import { describe, expect, it } from 'vitest';

import { auditLine } from './audit.js';

describe('auditLine', () => {
  it('contains only the operation class, outcome, and duration', () => {
    expect(auditLine('soqlQuery', 'ok', 12)).toBe(
      '{"event":"salesforce_operation","operation":"soqlQuery","outcome":"ok","durationMs":12}',
    );
  });

  it('does not echo unknown operation text', () => {
    const line = auditLine('accessTokenShouldNeverAppear', 'FORBIDDEN_OPERATION', 1);
    expect(line).not.toContain('accessTokenShouldNeverAppear');
    expect(JSON.parse(line).operation).toBe('unknown');
  });
});
