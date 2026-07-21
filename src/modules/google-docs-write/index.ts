import type Database from 'better-sqlite3';

import { GOOGLE_DOCS_WRITE_AGENT_GROUPS, GOOGLE_DOCS_WRITE_USERS } from '../../config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { executeGoogleDocsBatchUpdate } from './executor.js';
import { consumeGoogleDocsWriteTurn } from './turn-authorization.js';

const DOCUMENT_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const MAX_REQUESTS = 100;
const MAX_BODY_BYTES = 1024 * 1024;

interface WritePolicy {
  allowedUsers: ReadonlySet<string>;
  allowedAgentGroups: ReadonlySet<string>;
}

interface WriteDeps {
  execute: typeof executeGoogleDocsBatchUpdate;
  respond: (session: Session, questionId: string, ok: boolean, message: string) => void;
}

const defaultPolicy: WritePolicy = {
  allowedUsers: GOOGLE_DOCS_WRITE_USERS,
  allowedAgentGroups: GOOGLE_DOCS_WRITE_AGENT_GROUPS,
};

const defaultDeps: WriteDeps = {
  execute: executeGoogleDocsBatchUpdate,
  respond: writeToolResponse,
};

export async function handleGoogleDocsWrite(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  policy: WritePolicy = defaultPolicy,
  deps: WriteDeps = defaultDeps,
): Promise<void> {
  const questionId = typeof content.questionId === 'string' ? content.questionId.trim() : '';
  if (!questionId) {
    log.warn('Google Docs update rejected', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      reason: 'questionId is required',
    });
    return;
  }

  try {
    if (!policy.allowedAgentGroups.has(session.agent_group_id)) {
      throw new Error('Google Docs writes are disabled for this agent group');
    }

    const sourceMessageId = requiredString(content, 'source_message_id');
    const source = inDb
      .prepare('SELECT kind, channel_type, content FROM messages_in WHERE id = ?')
      .get(sourceMessageId) as { kind: string; channel_type: string | null; content: string } | undefined;
    if (!source || (source.kind !== 'chat' && source.kind !== 'chat-sdk')) {
      throw new Error('the source is not a verified user message');
    }
    if (source.channel_type !== 'slack') throw new Error('Google Docs writes require a verified Slack sender');

    const documentId = requiredString(content, 'document_id');
    if (!DOCUMENT_ID_RE.test(documentId)) throw new Error('document_id is invalid');
    const requests = content.requests;
    if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_REQUESTS) {
      throw new Error(`requests must contain between 1 and ${MAX_REQUESTS} operations`);
    }
    if (Buffer.byteLength(JSON.stringify({ requests }), 'utf8') > MAX_BODY_BYTES) {
      throw new Error('the Google Docs update exceeds the 1 MiB safety limit');
    }

    const grant = consumeGoogleDocsWriteTurn(session.id, sourceMessageId, policy.allowedUsers);
    if (!grant.allowed) throw new Error(grant.reason);
    if (senderIdentity(source.content, source.channel_type) !== grant.userId) {
      throw new Error('the stored Slack sender does not match the authorized turn');
    }

    const result = await deps.execute(documentId, requests);
    deps.respond(
      session,
      questionId,
      true,
      `Google Doc ${result.documentId} updated successfully (${result.replyCount} operation replies).`,
    );
    log.info('Google Docs update completed', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      sourceMessageId,
      userId: grant.userId,
      documentId,
      requestCount: requests.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.respond(session, questionId, false, `Google Docs update denied or failed: ${message}`);
    log.warn('Google Docs update rejected', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      questionId,
      reason: message,
    });
  }
}

function writeToolResponse(session: Session, questionId: string, ok: boolean, message: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `docs-write-response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'google_docs_write_response',
      questionId,
      ok,
      message,
    }),
    trigger: 0,
  });
}

function requiredString(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} is required`);
  return value.trim();
}

function senderIdentity(rawContent: string, channelType: string): string | null {
  try {
    const content = JSON.parse(rawContent) as { senderId?: unknown; author?: { userId?: unknown } };
    const raw =
      typeof content.senderId === 'string'
        ? content.senderId
        : typeof content.author?.userId === 'string'
          ? content.author.userId
          : null;
    if (!raw) return null;
    return raw.includes(':') ? raw : `${channelType}:${raw}`;
  } catch {
    return null;
  }
}

registerDeliveryAction(
  'update_google_document',
  (content, session, inDb) => handleGoogleDocsWrite(content, session, inDb),
  unguarded('host-enforced one-shot sender authorization and isolated OneCLI writer identity'),
);
