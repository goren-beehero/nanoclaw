#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AircallClient } from "./aircall-client.js";

for (const name of ["AIRCALL_API_ID", "AIRCALL_API_TOKEN", "AIRCALL_AUTHORIZATION", "AIRCALL_BASIC_AUTH"]) {
  if (process.env[name]) {
    throw new Error(`${name} must remain in OneCLI and must not be exposed to the MCP process`);
  }
}

const client = new AircallClient({
  baseUrl: process.env.AIRCALL_URL ?? "https://api.aircall.io/v1",
  allowedHost: process.env.AIRCALL_ALLOWED_HOST ?? "api.aircall.io",
});

const pageFields = {
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(100).default(50),
};

const callWindowFields = {
  from: z.union([z.string(), z.number()]).optional().describe("UNIX seconds or parseable date/time"),
  to: z.union([z.string(), z.number()]).optional().describe("UNIX seconds or parseable date/time"),
  lastHours: z.number().int().min(1).max(744).default(24),
};

const server = new McpServer({ name: "beehero-aircall-readonly", version: "0.1.0" });

server.registerTool(
  "aircall_ping",
  {
    description: "Verify Aircall API reachability through the OneCLI-managed credential without exposing the credential",
    inputSchema: {},
  },
  async () => textResult(await client.ping()),
);

server.registerTool(
  "list_aircall_calls",
  {
    description:
      "List recent Aircall call metadata for bounded operational analysis. Phone numbers and media URLs are redacted; max window is 31 days.",
    inputSchema: {
      ...callWindowFields,
      ...pageFields,
      order: z.enum(["asc", "desc"]).default("desc"),
      direction: z.enum(["inbound", "outbound"]).optional(),
      userId: z.number().int().positive().optional(),
      phoneNumber: z.string().min(3).max(40).optional().describe("Use only when the user explicitly provides a phone number"),
      tags: z.array(z.number().int().positive()).max(10).optional(),
      fetchCallTimeline: z.boolean().default(false),
      fetchAivaConv: z.boolean().default(false),
    },
  },
  async (args) => textResult(await client.listCalls(args)),
);

server.registerTool(
  "get_aircall_call",
  {
    description:
      "Retrieve one Aircall call record by ID. Media URLs are always redacted; phone numbers are masked unless includeSensitive is explicitly true.",
    inputSchema: {
      callId: z.number().int().positive(),
      fetchCallTimeline: z.boolean().default(false),
      fetchAivaConv: z.boolean().default(false),
      fetchContact: z.boolean().default(false),
      includeSensitive: z.boolean().default(false),
    },
  },
  async (args) => textResult(await client.getCall(args.callId, args)),
);

server.registerTool(
  "get_aircall_call_intelligence",
  {
    description:
      "Retrieve single-call Aircall AI artifacts for analysis. Handles unavailable AI Assist endpoints without failing the whole call.",
    inputSchema: {
      callId: z.number().int().positive(),
      transcription: z.boolean().default(true),
      sentiments: z.boolean().default(true),
      predictedCsat: z.boolean().default(false),
      topics: z.boolean().default(true),
      summary: z.boolean().default(true),
      customSummary: z.boolean().default(false),
      actionItems: z.boolean().default(true),
      playbookResult: z.boolean().default(false),
      evaluations: z.boolean().default(false),
    },
  },
  async ({ callId, ...include }) => textResult(await client.getCallIntelligence(callId, include)),
);

server.registerTool(
  "list_aircall_users",
  {
    description: "List Aircall users for mapping a person name to user ID before a bounded call search",
    inputSchema: pageFields,
  },
  async (args) => textResult(await client.listUsers(args)),
);

server.registerTool(
  "list_aircall_numbers",
  {
    description: "List Aircall numbers/lines for mapping call routing, country, or line names",
    inputSchema: pageFields,
  },
  async (args) => textResult(await client.listNumbers(args)),
);

server.registerTool(
  "list_aircall_tags",
  {
    description: "List Aircall tags for mapping a tag name to an ID before a bounded call search",
    inputSchema: pageFields,
  },
  async (args) => textResult(await client.listTags(args)),
);

server.registerTool(
  "list_aircall_teams",
  {
    description: "List Aircall teams for interpreting call ownership and queues",
    inputSchema: pageFields,
  },
  async (args) => textResult(await client.listTeams(args)),
);

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

await server.connect(new StdioServerTransport());
