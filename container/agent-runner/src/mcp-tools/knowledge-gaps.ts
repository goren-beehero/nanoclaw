import { getCurrentInReplyTo } from '../db/session-state.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const categories = ['missing_route', 'missing_capability', 'unsupported_action'] as const;

function generateId(): string {
  return `gap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function required(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const recordKnowledgeGap: McpToolDefinition = {
  tool: {
    name: 'record_knowledge_gap',
    description:
      'Write-only: queue one unsupported route, capability, or action for offline operator review. Do not use for ambiguity, missing user inputs, transient failures, or known routes. This tool cannot read the backlog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: categories,
          description: 'missing_route, missing_capability, or unsupported_action',
        },
        capability_key: {
          type: 'string',
          description: 'Stable entity-independent capability family; omit user names, dates, IDs, and channel wording.',
        },
        summary: { type: 'string', description: 'Short operator-facing description of the missing capability.' },
        scope_boundary: { type: 'string', description: 'What could not be completed.' },
        route_attempted: { type: 'string', description: 'Supported route or capability checked before recording.' },
        example: {
          type: 'string',
          description: 'Optional brief redacted example; never include credentials or private URLs.',
        },
      },
      required: ['category', 'capability_key', 'summary', 'scope_boundary', 'route_attempted'],
    },
  },
  async handler(args) {
    const category = args.category;
    if (typeof category !== 'string' || !categories.includes(category as (typeof categories)[number])) {
      return {
        content: [{ type: 'text', text: `Error: category must be one of ${categories.join(', ')}` }],
        isError: true,
      };
    }
    const fields = ['capability_key', 'summary', 'scope_boundary', 'route_attempted'] as const;
    const values = Object.fromEntries(fields.map((field) => [field, required(args, field)]));
    const missing = fields.find((field) => values[field] === null);
    if (missing) {
      return { content: [{ type: 'text', text: `Error: ${missing} is required` }], isError: true };
    }

    writeMessageOut({
      id: generateId(),
      in_reply_to: getCurrentInReplyTo(),
      kind: 'system',
      content: JSON.stringify({
        action: 'record_knowledge_gap',
        category,
        ...values,
        example: typeof args.example === 'string' ? args.example : undefined,
        source_message_id: getCurrentInReplyTo(),
      }),
    });
    return { content: [{ type: 'text', text: 'Knowledge gap queued for offline review.' }] };
  },
};

registerTools([recordKnowledgeGap]);
