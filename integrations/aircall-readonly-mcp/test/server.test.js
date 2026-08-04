import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("advertises only bounded Aircall read-only tools over MCP", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIRCALL_URL: "https://api.aircall.io/v1",
      AIRCALL_API_TOKEN: "",
      AIRCALL_API_ID: "",
      AIRCALL_AUTHORIZATION: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "aircall-readonly-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(response.tools.map((tool) => tool.name).sort(), [
      "aircall_ping",
      "get_aircall_call",
      "get_aircall_call_intelligence",
      "list_aircall_calls",
      "list_aircall_numbers",
      "list_aircall_tags",
      "list_aircall_teams",
      "list_aircall_users",
    ]);
  } finally {
    await client.close();
  }
});

test("refuses direct Aircall credentials in process env", async () => {
  const result = await runServerWithEnv({
    ...process.env,
    AIRCALL_URL: "https://api.aircall.io/v1",
    AIRCALL_API_TOKEN: "must-not-enter-process",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AIRCALL_API_TOKEN/);
});

function runServerWithEnv(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}
