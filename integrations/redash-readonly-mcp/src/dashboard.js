const QUERY_PARAMETER_TYPES = new Set([
  "number",
  "enum",
  "query",
  "date",
  "datetime-local",
  "datetime-with-seconds",
  "date-range",
  "datetime-range",
  "datetime-range-with-seconds",
  "text",
  "text-pattern",
]);

export function summarizeDashboard(dashboard) {
  return {
    id: dashboard.id,
    name: dashboard.name,
    slug: dashboard.slug,
    updated_at: dashboard.updated_at,
    dashboard_filters_enabled: Boolean(dashboard.dashboard_filters_enabled),
    parameters: normalizeNamedList(dashboard.options?.parameters),
    widgets: widgets(dashboard).map((widget) => ({
      widget_id: widget.id,
      text: widget.text,
      visualization_id: widget.visualization_id ?? widget.visualization?.id,
      visualization_name: widget.visualization?.name,
      visualization_type: widget.visualization?.type,
      query_id: widget.visualization?.query_id,
      parameter_mappings: normalizeNamedMap(widget.options?.parameterMappings),
    })),
  };
}

export async function buildDashboardExecutionPlan(client, dashboard, supplied = {}) {
  const dashboardDefaults = new Map(
    normalizeNamedList(dashboard.options?.parameters).map((parameter) => [parameter.name, parameter.value]),
  );
  const queryCache = new Map();
  const plan = [];

  for (const widget of widgets(dashboard)) {
    const queryId = widget.visualization?.query_id;
    if (!Number.isInteger(queryId)) continue;

    let query = queryCache.get(queryId);
    if (!query) {
      query = await client.getQuery(queryId);
      queryCache.set(queryId, query);
    }

    const mappings = widget.options?.parameterMappings ?? {};
    const parameters = {};
    for (const definition of normalizeNamedList(query.options?.parameters)) {
      const mapping = mappings[definition.name] ?? {};
      const resolved = resolveParameter({
        definition,
        mapping,
        widgetId: widget.id,
        dashboardDefaults,
        supplied,
      });
      parameters[definition.name] = validateParameter(definition, resolved.value, resolved.userSupplied);
    }

    plan.push({
      widget_id: widget.id,
      visualization_id: widget.visualization_id ?? widget.visualization?.id,
      visualization_name: widget.visualization?.name,
      query_id: queryId,
      query_name: query.name,
      parameters,
    });
  }

  return deduplicatePlan(plan);
}

export async function executeDashboardPlan(client, plan, options = {}) {
  const maxAgeSeconds = boundedInteger(options.maxAgeSeconds ?? 1800, 60, 86_400, "maxAgeSeconds");
  const rowLimit = boundedInteger(options.rowLimit ?? 200, 1, 1000, "rowLimit");
  const concurrency = boundedInteger(options.concurrency ?? 3, 1, 5, "concurrency");
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
  const queue = [...plan.executions];
  const results = [];

  async function worker() {
    while (queue.length) {
      const execution = queue.shift();
      try {
        const first = await client.executeSavedQuery(
          execution.query_id,
          execution.parameters,
          maxAgeSeconds,
        );
        const queryResult = await resolveQueryResult(client, first, pollIntervalMs, pollTimeoutMs);
        results.push({ ...execution, ok: true, result: limitQueryResult(queryResult, rowLimit) });
      } catch (error) {
        results.push({ ...execution, ok: false, error: safeError(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  results.sort((a, b) => a.execution_id.localeCompare(b.execution_id));
  return { executions: results, widgets: plan.widgets };
}

export function limitQueryResult(payload, rowLimit) {
  const result = payload?.query_result ?? payload;
  const rows = Array.isArray(result?.data?.rows) ? result.data.rows : [];
  return {
    id: result?.id,
    query_id: result?.query_id,
    retrieved_at: result?.retrieved_at,
    runtime: result?.runtime,
    columns: Array.isArray(result?.data?.columns) ? result.data.columns : [],
    rows: rows.slice(0, rowLimit),
    returned_rows: Math.min(rows.length, rowLimit),
    total_rows: rows.length,
    truncated: rows.length > rowLimit,
  };
}

async function resolveQueryResult(client, initial, pollIntervalMs, pollTimeoutMs) {
  if (initial?.query_result) return initial.query_result;
  if (initial?.id && initial?.data?.rows) return initial;
  const jobId = initial?.job?.id;
  if (!jobId) throw new Error("Redash returned neither a query result nor a job");

  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const response = await client.getJob(jobId);
    const job = response?.job ?? response;
    if (job?.status === 3 && job.query_result_id) {
      return client.getQueryResult(job.query_result_id);
    }
    if ([4, 5].includes(job?.status)) throw new Error(`Redash query job ended with status ${job.status}`);
    await sleep(pollIntervalMs);
  }
  throw new Error("Redash query job timed out");
}

function resolveParameter({ definition, mapping, widgetId, dashboardDefaults, supplied }) {
  const mappingType = mapping.type ?? "widget-level";
  if (mappingType === "static-value") return { value: mapping.value, userSupplied: false };
  if (mappingType === "dashboard-level") {
    const dashboardName = mapping.mapTo ?? definition.name;
    if (Object.hasOwn(supplied.dashboard ?? {}, dashboardName)) {
      return { value: supplied.dashboard[dashboardName], userSupplied: true };
    }
    if (dashboardDefaults.has(dashboardName)) {
      return { value: dashboardDefaults.get(dashboardName), userSupplied: false };
    }
    return { value: definition.value, userSupplied: false };
  }

  const widgetValues = supplied.widgets?.[String(widgetId)] ?? supplied.widgets?.[widgetId] ?? {};
  if (Object.hasOwn(widgetValues, definition.name)) {
    return { value: widgetValues[definition.name], userSupplied: true };
  }
  return { value: definition.value, userSupplied: false };
}

function validateParameter(definition, value, userSupplied) {
  const type = definition.type ?? "text";
  if (!QUERY_PARAMETER_TYPES.has(type)) throw new Error(`Unsupported parameter type ${type}`);
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required parameter ${definition.name}`);
  }

  if (["text", "text-pattern"].includes(type)) {
    if (userSupplied) {
      throw new Error(`Text parameter ${definition.name} cannot be overridden by Bobi`);
    }
    return value;
  }
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Parameter ${definition.name} must be numeric`);
    return number;
  }
  if (type === "enum") {
    const allowed = enumValues(definition.enumOptions);
    const values = Array.isArray(value) ? value : [value];
    if (!allowed.length || values.some((entry) => !allowed.includes(String(entry)))) {
      throw new Error(`Parameter ${definition.name} must use a saved dropdown value`);
    }
    return value;
  }
  if (type === "query") {
    if (userSupplied) {
      throw new Error(`Query-backed parameter ${definition.name} cannot be overridden until its choices are verified`);
    }
    return value;
  }
  if (type.includes("range")) {
    if (!isPlainObject(value) || !isIsoLike(value.start) || !isIsoLike(value.end)) {
      throw new Error(`Parameter ${definition.name} must contain ISO-like start and end values`);
    }
    return { start: value.start, end: value.end };
  }
  if (!isIsoLike(value)) throw new Error(`Parameter ${definition.name} must be an ISO-like date value`);
  return value;
}

function deduplicatePlan(entries) {
  const executions = [];
  const byKey = new Map();
  const widgetLinks = [];
  for (const entry of entries) {
    const key = `${entry.query_id}:${stableJson(entry.parameters)}`;
    let execution = byKey.get(key);
    if (!execution) {
      execution = {
        execution_id: `execution-${executions.length + 1}`,
        query_id: entry.query_id,
        query_name: entry.query_name,
        parameters: entry.parameters,
      };
      executions.push(execution);
      byKey.set(key, execution);
    }
    widgetLinks.push({
      widget_id: entry.widget_id,
      visualization_id: entry.visualization_id,
      visualization_name: entry.visualization_name,
      execution_id: execution.execution_id,
    });
  }
  return { executions, widgets: widgetLinks };
}

function widgets(dashboard) {
  return Array.isArray(dashboard?.widgets) ? dashboard.widgets : [];
}

function normalizeNamedList(value) {
  if (Array.isArray(value)) return value.filter((entry) => isPlainObject(entry) && entry.name);
  return normalizeNamedMap(value);
}

function normalizeNamedMap(value) {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).map(([name, entry]) => ({
    ...(isPlainObject(entry) ? entry : {}),
    name,
  }));
}

function enumValues(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function isIsoLike(value) {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unknown Redash error";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
