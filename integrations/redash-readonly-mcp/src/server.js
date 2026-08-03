#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RedashClient } from "./redash-client.js";
import {
  buildDashboardExecutionPlan,
  executeDashboardPlan,
  limitQueryResult,
  summarizeDashboard,
} from "./dashboard.js";

if (process.env.REDASH_API_KEY) {
  throw new Error("REDASH_API_KEY must remain in OneCLI and must not be exposed to the MCP process");
}

const client = new RedashClient({
  baseUrl: process.env.REDASH_URL ?? "https://internal.beehero.io",
  allowedHost: process.env.REDASH_ALLOWED_HOST ?? "internal.beehero.io",
  allowInsecureHttp: process.env.REDASH_ALLOW_INSECURE_HTTP === "true",
});

const server = new McpServer({ name: "beehero-redash-readonly", version: "0.1.0" });

server.registerTool(
  "get_redash_dashboard",
  {
    description: "Read a Redash dashboard definition and its query/parameter mappings without executing it",
    inputSchema: { dashboard: z.string().min(1).describe("Dashboard numeric ID or slug") },
  },
  async ({ dashboard }) => textResult(summarizeDashboard(await client.getDashboard(dashboard))),
);

server.registerTool(
  "get_redash_query",
  {
    description: "Read one saved Redash query definition by numeric ID",
    inputSchema: { queryId: z.number().int().positive() },
  },
  async ({ queryId }) => {
    const query = await client.getQuery(queryId);
    return textResult({
      id: query.id,
      name: query.name,
      description: query.description,
      query: query.query,
      data_source_id: query.data_source_id,
      updated_at: query.updated_at,
      parameters: query.options?.parameters ?? [],
      visualizations: query.visualizations ?? [],
    });
  },
);

server.registerTool(
  "get_redash_cached_query_result",
  {
    description: "Read the latest cached result for a non-parameterized saved query",
    inputSchema: {
      queryId: z.number().int().positive(),
      rowLimit: z.number().int().min(1).max(1000).default(200),
    },
  },
  async ({ queryId, rowLimit }) => textResult(limitQueryResult(await client.getCachedQueryResult(queryId), rowLimit)),
);

server.registerTool(
  "run_redash_dashboard",
  {
    description: "Execute only the saved queries already attached to a Redash dashboard using validated dashboard/widget parameters",
    inputSchema: {
      dashboard: z.string().min(1).describe("Dashboard numeric ID or slug"),
      dashboardParameters: z.record(z.string(), z.unknown()).default({}),
      widgetParameters: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      maxAgeSeconds: z.number().int().min(60).max(86400).default(1800),
      rowLimit: z.number().int().min(1).max(1000).default(200),
    },
  },
  async ({ dashboard, dashboardParameters, widgetParameters, maxAgeSeconds, rowLimit }) => {
    const definition = await client.getDashboard(dashboard);
    const plan = await buildDashboardExecutionPlan(client, definition, {
      dashboard: dashboardParameters,
      widgets: widgetParameters,
    });
    return textResult({
      dashboard: summarizeDashboard(definition),
      ...(await executeDashboardPlan(client, plan, { maxAgeSeconds, rowLimit })),
    });
  },
);

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

await server.connect(new StdioServerTransport());
