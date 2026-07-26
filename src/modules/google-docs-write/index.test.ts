import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '../../types.js';
import { handleGoogleDocsWrite } from './index.js';
import { clearGoogleDocsWriteTurnsForTest, recordGoogleDocsWriteTurn } from './turn-authorization.js';

const session = {
  id: 'sess-bobi-product',
  agent_group_id: 'ag-bobi',
  messaging_group_id: 'mg-bobi-product',
  thread_id: '1784624392.606849',
} as Session;

function inbound(messageId: string, senderId: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      channel_type TEXT,
      content TEXT NOT NULL
    )
  `);
  db.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)').run(
    messageId,
    'chat',
    'pending',
    'slack',
    JSON.stringify({ senderId, text: 'Please update the document' }),
  );
  return db;
}

afterEach(() => clearGoogleDocsWriteTurnsForTest());

describe('Google Docs write delivery action', () => {
  it('ignores malformed host actions that cannot be correlated to a tool request', async () => {
    const db = inbound('msg-owner', 'U-OWNER');
    let executed = false;
    let responded = false;

    await handleGoogleDocsWrite(
      { source_message_id: 'msg-owner', document_id: 'document_1234567890', requests: [{}] },
      session,
      db,
      { allowedUsers: new Set(['slack:U-OWNER']), allowedAgentGroups: new Set(['ag-bobi']) },
      {
        execute: async () => {
          executed = true;
          return { documentId: 'document_1234567890', replyCount: 1 };
        },
        respond: () => {
          responded = true;
        },
      },
    );

    expect(executed).toBe(false);
    expect(responded).toBe(false);
    db.close();
  });

  it('executes once for the configured owner in the existing session', async () => {
    const db = inbound('msg-owner', 'U-OWNER');
    recordGoogleDocsWriteTurn(session.id, 'msg-owner', 'slack:U-OWNER');
    const responses: Array<{ ok: boolean; message: string }> = [];
    const executions: unknown[][] = [];

    await handleGoogleDocsWrite(
      {
        questionId: 'req-1',
        source_message_id: 'msg-owner',
        document_id: 'document_1234567890',
        requests: [{ insertText: { location: { index: 1 }, text: 'Hello' } }],
      },
      session,
      db,
      { allowedUsers: new Set(['slack:U-OWNER']), allowedAgentGroups: new Set(['ag-bobi']) },
      {
        execute: async (_documentId, requests) => {
          executions.push(requests);
          return { documentId: 'document_1234567890', replyCount: requests.length };
        },
        respond: (_session, _questionId, ok, message) => responses.push({ ok, message }),
      },
    );

    expect(executions).toHaveLength(1);
    expect(responses).toEqual([{ ok: true, message: expect.stringContaining('updated successfully') }]);
    db.close();
  });

  it('denies a non-owner without executing', async () => {
    const db = inbound('msg-other', 'U-OTHER');
    recordGoogleDocsWriteTurn(session.id, 'msg-other', 'slack:U-OTHER');
    let executed = false;
    const responses: Array<{ ok: boolean; message: string }> = [];

    await handleGoogleDocsWrite(
      {
        questionId: 'req-2',
        source_message_id: 'msg-other',
        document_id: 'document_1234567890',
        requests: [{ insertText: { location: { index: 1 }, text: 'No' } }],
      },
      session,
      db,
      { allowedUsers: new Set(['slack:U-OWNER']), allowedAgentGroups: new Set(['ag-bobi']) },
      {
        execute: async () => {
          executed = true;
          return { documentId: 'document_1234567890', replyCount: 1 };
        },
        respond: (_session, _questionId, ok, message) => responses.push({ ok, message }),
      },
    );

    expect(executed).toBe(false);
    expect(responses).toEqual([
      {
        ok: false,
        message:
          "You don't have permission to edit Google Docs through Bobi. Ask <@U-OWNER> to send the edit instruction.",
      },
    ]);
    db.close();
  });

  it('denies replay of an earlier owner message after another sender posts', async () => {
    const db = inbound('msg-owner', 'U-OWNER');
    recordGoogleDocsWriteTurn(session.id, 'msg-owner', 'slack:U-OWNER');
    recordGoogleDocsWriteTurn(session.id, 'msg-other', 'slack:U-OTHER');
    const responses: Array<{ ok: boolean; message: string }> = [];

    await handleGoogleDocsWrite(
      {
        questionId: 'req-3',
        source_message_id: 'msg-owner',
        document_id: 'document_1234567890',
        requests: [{}],
      },
      session,
      db,
      { allowedUsers: new Set(['slack:U-OWNER']), allowedAgentGroups: new Set(['ag-bobi']) },
      {
        execute: async () => ({ documentId: 'document_1234567890', replyCount: 1 }),
        respond: (_session, _questionId, ok, message) => responses.push({ ok, message }),
      },
    );

    expect(responses).toEqual([{ ok: false, message: expect.stringContaining('newest') }]);
    db.close();
  });
});
