import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { RedashClient, isAllowedRequest } from "../src/redash-client.js";

let server;
let baseUrl;
const requests = [];

before(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server.close(resolve)));

test("allows only approved Redash endpoints and methods", () => {
  assert.equal(isAllowedRequest("GET", "/api/dashboards/health-overview"), true);
  assert.equal(isAllowedRequest("GET", "/api/queries/6636"), true);
  assert.equal(isAllowedRequest("POST", "/api/queries/6636/results"), true);
  assert.equal(isAllowedRequest("GET", "/api/jobs/22e8f33f-1b04-4dbe-b2b7-1a5aa53c8abf"), true);
  assert.equal(isAllowedRequest("GET", "/api/jobs/../../users"), false);
  assert.equal(isAllowedRequest("POST", "/api/queries"), false);
  assert.equal(isAllowedRequest("DELETE", "/api/dashboards/1"), false);
  assert.equal(isAllowedRequest("GET", "/api/data_sources"), false);
  assert.equal(isAllowedRequest("GET", "https://example.com/api/queries/1"), false);
});

test("never sends an authorization header itself", async () => {
  requests.length = 0;
  const client = new RedashClient({ baseUrl, allowInsecureLocalhost: true });
  await client.getQuery(6636);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, undefined);
});

test("accepts Redash UUID job ids without widening the path", async () => {
  requests.length = 0;
  const client = new RedashClient({ baseUrl, allowInsecureLocalhost: true });
  await client.getJob("22e8f33f-1b04-4dbe-b2b7-1a5aa53c8abf");
  assert.equal(requests[0].url, "/api/jobs/22e8f33f-1b04-4dbe-b2b7-1a5aa53c8abf");
  assert.throws(() => client.getJob("../../users"), /positive integer or UUID/);
});

test("requires an explicit opt-in for HTTP on the exact internal host", () => {
  assert.throws(
    () => new RedashClient({ baseUrl: "http://internal.beehero.io" }),
    /approved scheme and host/,
  );
  assert.doesNotThrow(
    () => new RedashClient({
      baseUrl: "http://internal.beehero.io",
      allowInsecureHttp: true,
    }),
  );
  assert.throws(
    () => new RedashClient({
      baseUrl: "http://example.com",
      allowInsecureHttp: true,
    }),
    /approved scheme and host/,
  );
});

test("blocks client methods from escaping the endpoint allowlist", async () => {
  const client = new RedashClient({ baseUrl, allowInsecureLocalhost: true });
  await assert.rejects(() => client.request("DELETE", "/api/queries/6636"), /Blocked Redash API/);
  await assert.rejects(() => client.request("GET", "/api/users"), /Blocked Redash API/);
});
