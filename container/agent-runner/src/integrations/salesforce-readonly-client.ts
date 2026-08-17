import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

const allowedOrigin = new URL('http://bobi-salesforce-readonly-adapter:8080');
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const;

export function hasPrivateAdapterProxyBypass(env: NodeJS.ProcessEnv): boolean {
  if (!proxyKeys.some((key) => Boolean(env[key]))) return true;
  const entries = [env.NO_PROXY, env.no_proxy]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return entries.includes(allowedOrigin.hostname.toLowerCase());
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const salesforceTools: Tool[] = [
  {
    name: 'getObjectSchema',
    description:
      'Returns Salesforce schema information. Omit all object arguments for the compact object index. For one object, use object-name; legacy singular aliases objects and sobject-name are also accepted.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        'object-name': { type: 'string' },
        objects: { type: 'string' },
        'sobject-name': { type: 'string' },
      },
    },
  },
  {
    name: 'soqlQuery',
    description:
      'Executes a bounded read-only SOQL SELECT query. Use query; legacy q is also accepted. Include a top-level WHERE or LIMIT, unless the SELECT is aggregate-only. If truncated is true or done is not true, the result is incomplete: never claim all, none missing, an exact total, or reconciliation completeness. Task/Event objects and polymorphic activity relationships may be unavailable. If an activity read fails, explicitly say activity data could not be verified; never infer that no activity or tasks exist.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      anyOf: [{ required: ['query'] }, { required: ['q'] }],
      properties: { query: { type: 'string' }, q: { type: 'string' } },
    },
  },
  {
    name: 'find',
    description:
      'Executes a bounded SOSL FIND search across Salesforce objects. Use search; legacy q is also accepted. If truncated is true, the result is incomplete and must not support completeness or exact-total claims.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      anyOf: [{ required: ['search'] }, { required: ['q'] }],
      properties: { search: { type: 'string' }, q: { type: 'string' } },
    },
  },
  {
    name: 'getUserInfo',
    description: 'Returns the authenticated Salesforce user identity and locale context.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'listRecentSobjectRecords',
    description: 'Returns recently viewed records for one Salesforce object type.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sobject-name'],
      properties: { 'sobject-name': { type: 'string' } },
    },
  },
  {
    name: 'getRelatedRecords',
    description:
      'Returns bounded child records for a Salesforce parent record relationship. If truncated is true or done is not true, the result is incomplete and must not support completeness or exact-total claims.',
    annotations: readOnlyAnnotations,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sobject-name', 'id', 'relationship-path'],
      properties: {
        'sobject-name': { type: 'string' },
        id: { type: 'string' },
        'relationship-path': { type: 'string' },
      },
    },
  },
];

const toolNames = new Set(salesforceTools.map((tool) => tool.name));
const errorCodes = new Set([
  'AUTH_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  'ACCESS_DENIED',
  'UNSUPPORTED_OBJECT_OR_FIELD',
  'INVALID_QUERY',
  'INVALID_INPUT',
  'RESPONSE_LIMIT_EXCEEDED',
  'FORBIDDEN_OPERATION',
]);

export async function callAdapter(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!toolNames.has(name)) throw new Error('FORBIDDEN_OPERATION');
  const url = new URL(`/v1/tools/${name}`, allowedOrigin);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !body.ok)
    throw new Error(body.error && errorCodes.has(body.error) ? body.error : 'UPSTREAM_UNAVAILABLE');
  return body.result;
}

async function main(): Promise<void> {
  if (!hasPrivateAdapterProxyBypass(process.env)) throw new Error('PRIVATE_ADAPTER_PROXY_BYPASS_REQUIRED');
  const server = new Server({ name: 'salesforce-durable-readonly', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: salesforceTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callAdapter(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UPSTREAM_UNAVAILABLE';
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch(() => process.exit(1));
}
