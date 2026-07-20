import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import {
  cleanupKnowledgeGapTestRun,
  knowledgeGapFingerprint,
  normalizeCapabilityKey,
  recordKnowledgeGap,
} from './knowledge-gaps.js';
import { runMigrations } from './migrations/index.js';

beforeEach(() => runMigrations(initTestDb()));
afterEach(() => closeDb());

const base = {
  category: 'unsupported_action' as const,
  summary: 'Run a production Airflow backfill',
  scopeBoundary: 'Production mutation is unavailable',
  routeAttempted: 'Airflow investigation route',
  channelType: 'slack',
  platformId: 'C-TEST',
  threadId: 'slack:C-TEST:1',
};

describe('knowledge gap storage', () => {
  it('normalizes volatile entities while preserving the capability family', () => {
    const first = normalizeCapabilityKey('Run Airflow backfill for DAG 123 on 2026-07-20');
    const second = normalizeCapabilityKey('run airflow backfill for dag 456 on 2026-07-21');
    expect(first).toBe(second);
    expect(knowledgeGapFingerprint('unsupported_action', first)).toBe(
      knowledgeGapFingerprint('unsupported_action', second),
    );
  });

  it('normalizes equivalent leading action verbs and separators', () => {
    const keys = ['trigger_airflow_backfill', 'execute Airflow backfill', 'run airflow-backfill'];
    expect(keys.map(normalizeCapabilityKey)).toEqual(['airflow backfill', 'airflow backfill', 'airflow backfill']);
    expect(new Set(keys.map((key) => knowledgeGapFingerprint('unsupported_action', key))).size).toBe(1);
  });

  it('deduplicates paraphrases and duplicate source events', () => {
    const one = recordKnowledgeGap({
      ...base,
      capabilityKey: 'Run Airflow backfill for DAG 123 on 2026-07-20',
      sourceEventKey: 'session-1:message-1',
      example: 'Please backfill DAG 123',
    });
    const duplicate = recordKnowledgeGap({
      ...base,
      capabilityKey: 'Run Airflow backfill for DAG 123 on 2026-07-20',
      sourceEventKey: 'session-1:message-1',
    });
    const paraphrase = recordKnowledgeGap({
      ...base,
      capabilityKey: 'run airflow backfill for dag 456 on 2026-07-21',
      sourceEventKey: 'session-2:message-2',
      example: 'Can you execute the historical Airflow run?',
    });

    expect(one.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(paraphrase.record.fingerprint).toBe(one.record.fingerprint);
    expect(paraphrase.record.occurrence_count).toBe(2);
    expect(paraphrase.record.example_count).toBe(2);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_gaps').get() as { n: number }).n).toBe(1);
  });

  it('keeps different missing capabilities separate', () => {
    recordKnowledgeGap({ ...base, capabilityKey: 'run airflow backfill', sourceEventKey: 's:1' });
    recordKnowledgeGap({
      ...base,
      category: 'missing_route',
      capabilityKey: 'look up unsupported billing ledger',
      sourceEventKey: 's:2',
    });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM knowledge_gaps').get() as { n: number }).n).toBe(2);
  });

  it('redacts examples and caps the stored set', () => {
    for (let i = 0; i < 5; i++) {
      recordKnowledgeGap({
        ...base,
        capabilityKey: 'run airflow backfill',
        sourceEventKey: `s:${i}`,
        example: `case-${i} token xoxb-secretvalue${i} https://internal.example/path/${i}?token=secret`,
      });
    }
    const row = getDb().prepare('SELECT example_count, examples FROM knowledge_gaps').get() as {
      example_count: number;
      examples: string;
    };
    expect(row.example_count).toBe(3);
    expect(row.examples).not.toContain('xoxb-');
    expect(row.examples).not.toContain('internal.example/path');
  });

  it('removes a test run precisely and restores production aggregates', () => {
    const production = recordKnowledgeGap({
      ...base,
      capabilityKey: 'run airflow backfill',
      sourceEventKey: 'prod:1',
      example: 'production example',
    });
    recordKnowledgeGap({
      ...base,
      capabilityKey: 'run airflow backfill',
      sourceEventKey: 'test:1',
      example: 'test example',
      testRunId: 'run-123',
    });
    recordKnowledgeGap({
      ...base,
      category: 'missing_route',
      capabilityKey: 'unsupported test-only route',
      sourceEventKey: 'test:2',
      testRunId: 'run-123',
    });

    const cleaned = cleanupKnowledgeGapTestRun('run-123');
    const restored = getDb()
      .prepare('SELECT occurrence_count, examples, test_run_id FROM knowledge_gaps WHERE fingerprint = ?')
      .get(production.record.fingerprint) as { occurrence_count: number; examples: string; test_run_id: string | null };
    expect(cleaned).toEqual({ occurrencesDeleted: 2, gapsDeleted: 1, threadClosuresDeleted: 0 });
    expect(restored.occurrence_count).toBe(1);
    expect(restored.examples).toContain('production example');
    expect(restored.examples).not.toContain('test example');
    expect(restored.test_run_id).toBeNull();
  });
});
