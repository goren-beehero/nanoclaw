import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setCurrentActionSource } from '../db/session-state.js';
import { updateGoogleDocument } from './google-docs-write.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('update_google_document tool', () => {
  it('directs policy questions to the owner without suggesting allowlist changes', () => {
    expect(updateGoogleDocument.tool.description).toContain('authorized document owner');
    expect(updateGoogleDocument.tool.description).toContain('never suggest allowlist');
  });

  it('stamps the exact current action source and waits for the host result', async () => {
    setCurrentActionSource('slack-message-1');
    const pending = updateGoogleDocument.handler({
      document_id: 'doc_1234567890',
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello' } }],
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const outbound = getOutboundDb().prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as {
      id: string;
      in_reply_to: string;
      content: string;
    };
    const payload = JSON.parse(outbound.content);
    expect(outbound.in_reply_to).toBe('slack-message-1');
    expect(payload).toMatchObject({
      action: 'update_google_document',
      source_message_id: 'slack-message-1',
      document_id: 'doc_1234567890',
    });

    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES (?, 2, 'system', ?, 'pending', ?)`,
      )
      .run(
        `response-${outbound.id}`,
        new Date().toISOString(),
        JSON.stringify({ questionId: outbound.id, ok: true, message: 'Document updated.' }),
      );

    expect(await pending).toEqual({ content: [{ type: 'text', text: 'Document updated.' }] });
  });

  it('refuses to queue a write without a current user turn', async () => {
    const response = await updateGoogleDocument.handler({ document_id: 'doc_1234567890', requests: [{}] });
    expect(response.isError).toBe(true);
    expect((getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n).toBe(0);
  });

  it('returns the host permission denial without rewriting it', async () => {
    setCurrentActionSource('slack-message-other');
    const pending = updateGoogleDocument.handler({
      document_id: 'doc_1234567890',
      requests: [{ insertText: { location: { index: 1 }, text: 'Denied' } }],
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const outbound = getOutboundDb().prepare("SELECT * FROM messages_out WHERE kind = 'system'").get() as {
      id: string;
    };
    const denial =
      "You don't have permission to edit Google Docs through Bobi. Ask <@U-OWNER> to send the edit instruction.";
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES (?, 2, 'system', ?, 'pending', ?)`,
      )
      .run(
        `response-${outbound.id}`,
        new Date().toISOString(),
        JSON.stringify({ questionId: outbound.id, ok: false, message: denial }),
      );

    expect(await pending).toEqual({
      content: [{ type: 'text', text: denial }],
      isError: true,
    });
  });
});
