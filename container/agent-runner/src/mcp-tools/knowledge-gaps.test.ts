import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setCurrentInReplyTo } from '../db/session-state.js';
import { recordKnowledgeGap } from './knowledge-gaps.js';

beforeEach(() => {
  initTestSessionDb();
  setCurrentInReplyTo('inbound-123');
});

afterEach(() => closeSessionDb());

describe('record_knowledge_gap tool', () => {
  it('describes the canonical-source attempt and exact-runner boundary', () => {
    expect(recordKnowledgeGap.tool.description).toContain('attempt the routed canonical source');
    expect(recordKnowledgeGap.tool.description).toContain('absence of an exact report runner');
    expect(recordKnowledgeGap.tool.description).toContain('absent historical source or audit ledger');
    expect(recordKnowledgeGap.tool.description).toContain('output-format change is not a gap');
    expect(recordKnowledgeGap.tool.description).toContain('out-of-domain requests');
  });

  it('queues one internal write-only event without a delivery destination', async () => {
    const result = await recordKnowledgeGap.handler({
      category: 'unsupported_action',
      capability_key: 'run production airflow backfill',
      summary: 'Execute a production backfill',
      scope_boundary: 'Mutation is unavailable',
      route_attempted: 'Airflow read-only investigation',
    });
    const row = getOutboundDb().prepare('SELECT * FROM messages_out').get() as {
      kind: string;
      in_reply_to: string;
      channel_type: string | null;
      platform_id: string | null;
      content: string;
    };
    expect(result.isError).not.toBe(true);
    expect(row.kind).toBe('system');
    expect(row.in_reply_to).toBe('inbound-123');
    expect(row.channel_type).toBeNull();
    expect(row.platform_id).toBeNull();
    expect(JSON.parse(row.content)).toMatchObject({
      action: 'record_knowledge_gap',
      source_message_id: 'inbound-123',
      category: 'unsupported_action',
    });
  });

  it('rejects ambiguity-shaped incomplete input without writing', async () => {
    const result = await recordKnowledgeGap.handler({
      category: 'missing_route',
      capability_key: '',
    });
    const count = getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number };
    expect(result.isError).toBe(true);
    expect(count.n).toBe(0);
  });
});
