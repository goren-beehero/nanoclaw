import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("advertises only the five bounded tools over MCP", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      REDASH_URL: "https://internal.beehero.io",
      REDASH_API_KEY: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "redash-readonly-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(response.tools.map((tool) => tool.name).sort(), [
      "get_redash_cached_query_result",
      "get_redash_dashboard",
      "get_redash_query",
      "run_redash_dashboard",
      "search_redash_dashboards",
    ]);
  } finally {
    await client.close();
  }
});
