import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getCurrentActionSource } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const RESPONSE_TIMEOUT_MS = 90_000;

function generateId(): string {
  return `docs-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function result(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

export const updateGoogleDocument: McpToolDefinition = {
  tool: {
    name: 'update_google_document',
    description:
      'Apply a Google Docs batchUpdate to one existing document. The host authorizes the verified sender of the current Slack turn. Relay user-facing permission denials verbatim. For policy questions, direct unauthorized requesters to the authorized document owner; never suggest allowlist or OAuth changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'Google document ID from its URL' },
        requests: {
          type: 'array',
          items: { type: 'object' },
          description: 'Google Docs API batchUpdate requests, in execution order',
        },
      },
      required: ['document_id', 'requests'],
    },
  },
  async handler(args) {
    const sourceMessageId = getCurrentActionSource();
    if (!sourceMessageId) return result('Error: no current user turn is available to authorize this write.', true);

    const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
    const requests = Array.isArray(args.requests) ? args.requests : [];
    if (!documentId || requests.length === 0) {
      return result('Error: document_id and at least one batchUpdate request are required.', true);
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      in_reply_to: sourceMessageId,
      kind: 'system',
      content: JSON.stringify({
        action: 'update_google_document',
        questionId: requestId,
        source_message_id: sourceMessageId,
        document_id: documentId,
        requests,
      }),
    });

    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(requestId);
      if (response) {
        const parsed = JSON.parse(response.content) as { ok?: boolean; message?: string };
        markCompleted([response.id]);
        return result(parsed.message ?? 'Google Docs write returned no result.', parsed.ok !== true);
      }
      await sleep(250);
    }
    return result('Error: Google Docs write timed out before the host returned a result.', true);
  },
};

registerTools([updateGoogleDocument]);
