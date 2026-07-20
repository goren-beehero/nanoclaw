import { createHash } from 'crypto';

import { getDb } from './connection.js';

export type KnowledgeGapCategory = 'missing_route' | 'missing_capability' | 'unsupported_action';
export type KnowledgeGapStatus = 'open' | 'triaged' | 'covered' | 'wont_cover';

const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 500;

export interface KnowledgeGapInput {
  category: KnowledgeGapCategory;
  capabilityKey: string;
  summary: string;
  scopeBoundary: string;
  routeAttempted: string;
  example?: string | null;
  sourceEventKey: string;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
  testRunId?: string | null;
}

export interface KnowledgeGapRecord {
  fingerprint: string;
  category: KnowledgeGapCategory;
  capability_key: string;
  summary: string;
  scope_boundary: string;
  route_attempted: string;
  status: KnowledgeGapStatus;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  example_count: number;
  examples: string;
  test_run_id: string | null;
}

export function normalizeCapabilityKey(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, ' device-id ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ' id ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' date ')
    .replace(/\b\d+\b/g, ' number ')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.replace(/^(?:run|execute|trigger|start|launch|perform|invoke|initiate)\s+/, '');
}

export function knowledgeGapFingerprint(category: KnowledgeGapCategory, capabilityKey: string): string {
  const normalized = normalizeCapabilityKey(capabilityKey);
  if (!normalized) throw new Error('capability_key must contain a stable capability description');
  return createHash('sha256').update(`${category}\n${normalized}`).digest('hex');
}

export function redactKnowledgeGapText(value: string): string {
  return value
    .replace(/\b(?:xox[baprs]-|sk-[A-Za-z0-9_-]*|gh[pousr]_|AKIA)[A-Za-z0-9_=-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED_KEY]')
    .replace(/https?:\/\/[^\s/]+\/(?:[^\s?#]+)(?:\?[^\s#]*)?/g, '[REDACTED_URL]')
    .slice(0, MAX_EXAMPLE_CHARS);
}

function asRecord(fingerprint: string): KnowledgeGapRecord {
  return getDb().prepare('SELECT * FROM knowledge_gaps WHERE fingerprint = ?').get(fingerprint) as KnowledgeGapRecord;
}

function recomputeCanonical(fingerprint: string): void {
  const occurrences = getDb()
    .prepare(
      `SELECT seen_at, example, test_run_id
       FROM knowledge_gap_occurrences
       WHERE fingerprint = ?
       ORDER BY seen_at ASC, id ASC`,
    )
    .all(fingerprint) as { seen_at: string; example: string | null; test_run_id: string | null }[];
  if (occurrences.length === 0) {
    getDb().prepare('DELETE FROM knowledge_gaps WHERE fingerprint = ?').run(fingerprint);
    return;
  }

  const examples: string[] = [];
  for (const row of occurrences) {
    if (row.example && !examples.includes(row.example)) examples.push(row.example);
    if (examples.length === MAX_EXAMPLES) break;
  }
  const testIds = [...new Set(occurrences.map((row) => row.test_run_id).filter((id): id is string => Boolean(id)))];
  const allAreOneTest = testIds.length === 1 && occurrences.every((row) => row.test_run_id === testIds[0]);
  getDb()
    .prepare(
      `UPDATE knowledge_gaps SET
         first_seen_at = ?,
         last_seen_at = ?,
         occurrence_count = ?,
         example_count = ?,
         examples = ?,
         test_run_id = ?
       WHERE fingerprint = ?`,
    )
    .run(
      occurrences[0].seen_at,
      occurrences[occurrences.length - 1].seen_at,
      occurrences.length,
      examples.length,
      JSON.stringify(examples),
      allAreOneTest ? testIds[0] : null,
      fingerprint,
    );
}

export function recordKnowledgeGap(input: KnowledgeGapInput): { record: KnowledgeGapRecord; inserted: boolean } {
  const capabilityKey = normalizeCapabilityKey(input.capabilityKey);
  const fingerprint = knowledgeGapFingerprint(input.category, capabilityKey);
  const now = new Date().toISOString();
  const example = input.example ? redactKnowledgeGapText(input.example) : null;

  return getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO knowledge_gaps
           (fingerprint, category, capability_key, summary, scope_boundary, route_attempted, status,
            first_seen_at, last_seen_at, occurrence_count, example_count, examples, test_run_id)
         VALUES (@fingerprint, @category, @capabilityKey, @summary, @scopeBoundary, @routeAttempted,
                 'open', @now, @now, 0, 0, '[]', @testRunId)`,
      )
      .run({
        fingerprint,
        category: input.category,
        capabilityKey,
        summary: redactKnowledgeGapText(input.summary),
        scopeBoundary: redactKnowledgeGapText(input.scopeBoundary),
        routeAttempted: redactKnowledgeGapText(input.routeAttempted),
        now,
        testRunId: input.testRunId ?? null,
      });

    const inserted =
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO knowledge_gap_occurrences
           (fingerprint, source_event_key, seen_at, channel_type, platform_id, thread_id, example, test_run_id)
         VALUES (@fingerprint, @sourceEventKey, @now, @channelType, @platformId, @threadId, @example, @testRunId)`,
        )
        .run({
          fingerprint,
          sourceEventKey: `${input.sourceEventKey}:${fingerprint}`,
          now,
          channelType: input.channelType ?? null,
          platformId: input.platformId ?? null,
          threadId: input.threadId ?? null,
          example,
          testRunId: input.testRunId ?? null,
        }).changes > 0;

    if (inserted) recomputeCanonical(fingerprint);
    return { record: asRecord(fingerprint), inserted };
  })();
}

export function getKnowledgeGapTestRun(
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
): string | null {
  if (!channelType || !platformId || !threadId) return null;
  const now = new Date().toISOString();
  getDb().prepare('DELETE FROM knowledge_gap_test_scopes WHERE expires_at <= ?').run(now);
  const row = getDb()
    .prepare(
      `SELECT test_run_id FROM knowledge_gap_test_scopes
       WHERE channel_type = ? AND platform_id = ? AND thread_id = ? AND expires_at > ?`,
    )
    .get(channelType, platformId, threadId, now) as { test_run_id: string } | undefined;
  return row?.test_run_id ?? null;
}

export function cleanupKnowledgeGapTestRun(testRunId: string): { occurrencesDeleted: number; gapsDeleted: number } {
  return getDb().transaction(() => {
    const fingerprints = (
      getDb()
        .prepare('SELECT DISTINCT fingerprint FROM knowledge_gap_occurrences WHERE test_run_id = ?')
        .all(testRunId) as { fingerprint: string }[]
    ).map((row) => row.fingerprint);
    const before = fingerprints.filter((fingerprint) => asRecord(fingerprint)).length;
    const occurrencesDeleted = getDb()
      .prepare('DELETE FROM knowledge_gap_occurrences WHERE test_run_id = ?')
      .run(testRunId).changes;
    for (const fingerprint of fingerprints) recomputeCanonical(fingerprint);
    const remaining = fingerprints.filter(
      (fingerprint) =>
        getDb().prepare('SELECT 1 FROM knowledge_gaps WHERE fingerprint = ?').get(fingerprint) !== undefined,
    ).length;
    getDb().prepare('DELETE FROM knowledge_gap_test_scopes WHERE test_run_id = ?').run(testRunId);
    return { occurrencesDeleted, gapsDeleted: before - remaining };
  })();
}
