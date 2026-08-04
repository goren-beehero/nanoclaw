import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardSearchText, rankDashboards } from "../src/dashboard-search.js";

const now = new Date("2026-08-04T00:00:00Z");

const dashboards = [
  {
    id: 331,
    name: "FW VER - ON Season 175 AUS",
    slug: "fw-ver---on-season-175-aus",
    updated_at: "2026-08-03T12:17:30Z",
    widgets: [
      { visualization: { name: "Gwys count", query: { name: "Daily Active Gateways", description: "Gateway firmware health" } } },
      { visualization: { name: "IHD versions", query: { name: "Daily Active Sensors" } } },
      { visualization: { name: "Interrupts", query: { name: "Interrupts - Season 175" } } },
    ],
  },
  {
    id: 332,
    name: "Season 175 Commercial Overview",
    slug: "season-175-commercial-overview",
    updated_at: "2026-08-02T12:00:00Z",
    widgets: [{ visualization: { query: { name: "Contract and billing status" } } }],
  },
  {
    id: 100,
    name: "Hardware Monitoring 2024",
    slug: "hardware-monitoring-2024",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

for (const dashboard of dashboards) dashboard.search_text = dashboardSearchText(dashboard);

test("ranks a behavior-style hardware request above a generic season dashboard", () => {
  const result = rankDashboards("hardware dashboard that monitors season 175", dashboards, { now });
  assert.equal(result.best_match.id, 331);
  assert.equal(result.confidence, "high");
  assert.equal(result.auto_select, true);
});

test("tolerates a typo in a meaningful title token", () => {
  const result = rankDashboards("firmare seson 175", dashboards, { now });
  assert.equal(result.best_match.id, 331);
});

test("excludes stale dashboards by default", () => {
  const result = rankDashboards("hardware monitoring", dashboards, { now });
  assert.notEqual(result.best_match?.id, 100);
  assert.equal(result.candidates.some((candidate) => candidate.id === 100), false);
});

test("does not auto-select an ambiguous pair", () => {
  const pair = [
    { id: 1, name: "Sensor Health AUS", slug: "sensor-health-aus", updated_at: "2026-08-03T00:00:00Z" },
    { id: 2, name: "Sensor Health USA", slug: "sensor-health-usa", updated_at: "2026-08-03T00:00:00Z" },
  ];
  const result = rankDashboards("sensor health", pair, { now });
  assert.equal(result.auto_select, false);
  assert.equal(result.confidence, "medium");
});

test("returns no candidate for an unrelated request", () => {
  const result = rankDashboards("payroll recruitment", dashboards, { now });
  assert.equal(result.best_match, null);
  assert.equal(result.auto_select, false);
});

test("search text omits SQL and API key fields", () => {
  const text = dashboardSearchText({
    name: "Safe",
    api_key: "dashboard-secret",
    widgets: [{ visualization: { query: { name: "Useful query", query: "select secret", api_key: "query-secret" } } }],
  });
  assert.match(text, /Useful query/);
  assert.doesNotMatch(text, /select secret|dashboard-secret|query-secret/);
});
