import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboardExecutionPlan, executeDashboardPlan } from "../src/dashboard.js";

const dashboard = {
  id: 20,
  name: "Operations",
  options: {
    parameters: [{ name: "season", type: "number", value: 2025 }],
  },
  widgets: [
    {
      id: 1,
      visualization: { id: 11, query_id: 101, name: "Frames", type: "CHART" },
      options: { parameterMappings: { year: { type: "dashboard-level", mapTo: "season" } } },
    },
    {
      id: 2,
      visualization: { id: 12, query_id: 102, name: "Hives", type: "TABLE" },
      options: {
        parameterMappings: {
          season_id: { type: "dashboard-level", mapTo: "season" },
          market: { type: "static-value", value: "AUS" },
        },
      },
    },
    {
      id: 3,
      visualization: { id: 13, query_id: 101, name: "Frames duplicate", type: "TABLE" },
      options: { parameterMappings: { year: { type: "dashboard-level", mapTo: "season" } } },
    },
  ],
};

const queries = new Map([
  [101, { id: 101, name: "Frames", options: { parameters: [{ name: "year", type: "number" }] } }],
  [102, { id: 102, name: "Hives", options: { parameters: [
    { name: "season_id", type: "number" },
    { name: "market", type: "enum", enumOptions: ["AUS", "USA"] },
  ] } }],
]);

test("maps dashboard/static parameters and deduplicates identical executions", async () => {
  const client = { getQuery: async (id) => queries.get(id) };
  const plan = await buildDashboardExecutionPlan(client, dashboard, { dashboard: { season: 2026 } });
  assert.equal(plan.executions.length, 2);
  assert.deepEqual(plan.executions[0].parameters, { year: 2026 });
  assert.deepEqual(plan.executions[1].parameters, { season_id: 2026, market: "AUS" });
  assert.equal(plan.widgets[0].execution_id, plan.widgets[2].execution_id);
});

test("resolves query ids from the embedded visualization query shape", async () => {
  const deployedShape = {
    widgets: [{
      id: 20,
      visualization_id: 13358,
      visualization: {
        id: 13358,
        name: "Gateways",
        type: "CHART",
        query: { id: 101 },
      },
      options: { parameterMappings: {} },
    }],
  };

  const client = { getQuery: async (id) => ({ id, name: "Gateways", options: { parameters: [] } }) };
  const plan = await buildDashboardExecutionPlan(client, deployedShape, {});

  assert.equal(plan.executions.length, 1);
  assert.equal(plan.executions[0].query_id, 101);
  assert.equal(plan.widgets[0].visualization_id, 13358);
});

test("rejects user overrides for raw text and query-backed parameters", async () => {
  const textDashboard = {
    widgets: [{
      id: 9,
      visualization: { query_id: 109 },
      options: { parameterMappings: { customer: { type: "dashboard-level", mapTo: "customer" } } },
    }],
  };
  const client = { getQuery: async () => ({
    id: 109,
    name: "Unsafe",
    options: { parameters: [{ name: "customer", type: "text", value: "saved" }] },
  }) };
  await assert.rejects(
    () => buildDashboardExecutionPlan(client, textDashboard, { dashboard: { customer: "injected" } }),
    /cannot be overridden/,
  );
});

test("allows a dashboard-owned static text value but not a caller override", async () => {
  const textDashboard = {
    widgets: [{
      id: 10,
      visualization: { query_id: 110 },
      options: { parameterMappings: { customer: { type: "static-value", value: "saved-by-owner" } } },
    }],
  };
  const client = { getQuery: async () => ({
    id: 110,
    name: "Static text",
    options: { parameters: [{ name: "customer", type: "text", value: "query-default" }] },
  }) };
  const plan = await buildDashboardExecutionPlan(client, textDashboard, {});
  assert.equal(plan.executions[0].parameters.customer, "saved-by-owner");
});

test("keeps partial failures and returns each successful execution once", async () => {
  const calls = [];
  const client = {
    executeSavedQuery: async (id) => {
      calls.push(id);
      if (id === 102) throw new Error("HTTP 500 body must not leak");
      return { query_result: { id: 501, query_id: id, data: { columns: [{ name: "n" }], rows: [{ n: 1 }, { n: 2 }] } } };
    },
  };
  const plan = {
    executions: [
      { execution_id: "execution-1", query_id: 101, parameters: {} },
      { execution_id: "execution-2", query_id: 102, parameters: {} },
    ],
    widgets: [],
  };
  const result = await executeDashboardPlan(client, plan, { rowLimit: 1, pollIntervalMs: 1 });
  assert.deepEqual(calls.sort(), [101, 102]);
  assert.equal(result.executions[0].result.rows.length, 1);
  assert.equal(result.executions[0].result.truncated, true);
  assert.equal(result.executions[1].ok, false);
});
