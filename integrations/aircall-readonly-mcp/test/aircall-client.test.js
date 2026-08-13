import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCallParams, AircallClient, isAllowedRequest } from "../src/aircall-client.js";
import { sanitizeAircall, summarizeCall } from "../src/sanitize.js";

test("allowlist permits only bounded read-only Aircall endpoints", () => {
  assert.equal(isAllowedRequest("GET", "/v1/ping"), true);
  assert.equal(isAllowedRequest("GET", "/v1/calls"), true);
  assert.equal(isAllowedRequest("GET", "/v1/calls/search"), true);
  assert.equal(isAllowedRequest("GET", "/v1/calls/123"), true);
  assert.equal(isAllowedRequest("GET", "/v1/calls/123/transcription"), true);
  assert.equal(isAllowedRequest("GET", "/v1/calls/123/action_items"), true);
  assert.equal(isAllowedRequest("GET", "/v1/users"), true);
  assert.equal(isAllowedRequest("GET", "/v1/numbers/44"), true);

  assert.equal(isAllowedRequest("POST", "/v1/calls/123/comments"), false);
  assert.equal(isAllowedRequest("POST", "/v1/calls/123/tags"), false);
  assert.equal(isAllowedRequest("PUT", "/v1/calls/123/archive"), false);
  assert.equal(isAllowedRequest("DELETE", "/v1/calls/123/recording"), false);
  assert.equal(isAllowedRequest("GET", "/v1/webhooks"), false);
  assert.equal(isAllowedRequest("GET", "/v1/calls/abc"), false);
});

test("client rejects credentials and non-Aircall hosts in AIRCALL_URL", () => {
  assert.throws(() => new AircallClient({ baseUrl: "http://api.aircall.io/v1" }), /https/);
  assert.throws(() => new AircallClient({ baseUrl: "https://evil.example/v1" }), /api\.aircall\.io/);
  assert.throws(() => new AircallClient({ baseUrl: "https://user:pass@api.aircall.io/v1" }), /credentials/);
  assert.doesNotThrow(() => new AircallClient({ baseUrl: "https://api.aircall.io/v1" }));
});

test("call params bound windows and normalize dates", () => {
  const params = buildCallParams(
    { from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z", perPage: 100, direction: "inbound" },
    { maxWindowDays: 31 },
  );
  assert.equal(params.from, 1785542400);
  assert.equal(params.to, 1785628800);
  assert.equal(params.per_page, 100);
  assert.equal(params.direction, "inbound");

  assert.throws(
    () => buildCallParams({ from: "2026-08-01T00:00:00Z", to: "2026-09-15T00:00:00Z" }, { maxWindowDays: 31 }),
    /31 days/,
  );
});

test("sanitizer masks phones and media URLs", () => {
  const sanitized = sanitizeAircall({
    raw_digits: "+1 800-123-4567",
    recording: "https://recording.example/secret",
    nested: { phone_number: "+972501234567", asset: "https://asset.example/secret" },
  });
  assert.equal(sanitized.raw_digits, "+***4567");
  assert.deepEqual(sanitized.recording, { available: true, redacted: "media-url" });
  assert.equal(sanitized.nested.phone_number, "+***4567");
  assert.deepEqual(sanitized.nested.asset, { available: true, redacted: "media-url" });
});

test("call summaries are compact and private by default", () => {
  assert.deepEqual(
    summarizeCall({
      id: 12,
      direction: "inbound",
      status: "done",
      raw_digits: "+1 800-123-4567",
      duration: 31,
      recording: "https://recording.example/secret",
      user: { id: 7, name: "BeeHero Agent", email: "agent@beehero.io", direct_link: "https://api.aircall.io/v1/users/7" },
      number: { id: 9, name: "Support", digits: "+1 800-765-4321", country: "US" },
      tags: [{ id: 5, name: "Support" }],
      comments: [{ id: 1 }],
    }),
    {
      id: 12,
      sid: undefined,
      direction: "inbound",
      status: "done",
      missed_call_reason: undefined,
      started_at: undefined,
      answered_at: undefined,
      ended_at: undefined,
      duration: 31,
      raw_digits: "+***4567",
      user: {
        id: 7,
        name: "BeeHero Agent",
        email: "agent@beehero.io",
        availability_status: undefined,
        time_zone: undefined,
      },
      assigned_to: null,
      number: {
        id: 9,
        name: "Support",
        country: "US",
        time_zone: undefined,
        digits: "+***4321",
        availability_status: undefined,
        is_ivr: undefined,
      },
      teams: [],
      tags: [{ id: 5, name: "Support" }],
      comments_count: 1,
      has_recording: true,
      has_voicemail: false,
      has_asset: false,
      archived: undefined,
    },
  );
});
