import axios from "axios";
import { dashboardSearchText, rankDashboards } from "./dashboard-search.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class RedashError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RedashError";
    this.status = status;
  }
}

export class RedashClient {
  constructor({
    baseUrl,
    allowedHost = "internal.beehero.io",
    allowInsecureLocalhost = false,
    allowInsecureHttp = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }) {
    const url = new URL(baseUrl);
    const localTestHost = allowInsecureLocalhost && ["127.0.0.1", "localhost"].includes(url.hostname);
    const allowedProtocol = url.protocol === "https:" || (allowInsecureHttp && url.protocol === "http:");
    if (!localTestHost && (!allowedProtocol || url.hostname !== allowedHost)) {
      throw new Error(`REDASH_URL must use the approved scheme and host ${allowedHost}`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("REDASH_URL must not contain credentials, a query string, or a fragment");
    }

    this.http = axios.create({
      baseURL: url.origin,
      timeout: timeoutMs,
      maxContentLength: maxResponseBytes,
      maxBodyLength: maxResponseBytes,
      headers: { Accept: "application/json" },
      validateStatus: () => true,
    });
  }

  async request(method, path, { params, data } = {}) {
    if (!isAllowedRequest(method, path)) {
      throw new Error(`Blocked Redash API operation: ${method} ${path}`);
    }

    let response;
    try {
      response = await this.http.request({ method, url: path, params, data });
    } catch (error) {
      const reason = error?.code === "ECONNABORTED" ? "request timed out" : "request failed";
      throw new RedashError(`Redash ${reason}`);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new RedashError(`Redash API returned HTTP ${response.status}`, response.status);
    }
    return response.data;
  }

  getDashboard(identifier) {
    return this.request("GET", `/api/dashboards/${encodeIdentifier(identifier, "dashboard")}`);
  }

  async resolveDashboard(identifier) {
    const value = String(identifier).trim();
    if (/^[A-Za-z0-9_-]+$/.test(value)) {
      try {
        return await this.getDashboard(value);
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }

    const dashboards = await this.listDashboards();
    const matches = dashboards.filter(
      (dashboard) => dashboard?.name?.localeCompare(value, undefined, { sensitivity: "accent" }) === 0,
    );

    if (matches.length === 1) return this.getDashboard(matches[0].slug ?? matches[0].id);
    if (matches.length > 1) throw new Error("Dashboard title is ambiguous; use its numeric ID or slug");

    const search = await this.searchDashboards(value, { dashboards, limit: 3 });
    if (search.auto_select && search.best_match) {
      return this.getDashboard(search.best_match.slug ?? search.best_match.id);
    }
    if (search.candidates.length) {
      const names = search.candidates.map((candidate) => `${candidate.name} (#${candidate.id})`).join(", ");
      throw new Error(`Dashboard search was ambiguous; use one of: ${names}`);
    }
    throw new Error("Dashboard not found by title, topic, numeric ID, or slug");
  }

  async listDashboards() {
    const dashboards = [];
    const pageSize = 100;
    for (let page = 1; page <= 20; page += 1) {
      const response = await this.request("GET", "/api/dashboards", {
        params: { page, page_size: pageSize, order: "-updated_at" },
      });
      dashboards.push(...(response?.results ?? []));
      const total = Number(response?.count ?? 0);
      if (page * pageSize >= total || !(response?.results?.length)) break;
    }
    return dashboards;
  }

  async searchDashboards(query, options = {}) {
    const limit = options.limit ?? 5;
    const maxAgeDays = options.maxAgeDays ?? 365;
    const dashboards = options.dashboards ?? await this.listDashboards();
    const shortlistSize = Math.min(20, Math.max(12, limit * 4));
    const preliminary = rankDashboards(query, dashboards, { limit: shortlistSize, maxAgeDays });
    const byId = new Map(dashboards.map((dashboard) => [dashboard.id, dashboard]));
    const shortlist = preliminary.candidates.map((candidate) => byId.get(candidate.id)).filter(Boolean);

    for (const dashboard of dashboards.slice(0, shortlistSize)) {
      if (!shortlist.some((candidate) => candidate.id === dashboard.id)) shortlist.push(dashboard);
      if (shortlist.length >= shortlistSize) break;
    }

    const hydrated = await mapWithConcurrency(shortlist, 5, async (dashboard) => {
      try {
        const definition = await this.getDashboard(dashboard.slug ?? dashboard.id);
        return { ...dashboard, ...definition, search_text: dashboardSearchText(definition) };
      } catch {
        return { ...dashboard, search_text: dashboardSearchText(dashboard) };
      }
    });
    return rankDashboards(query, hydrated, { limit, maxAgeDays });
  }

  getQuery(queryId) {
    return this.request("GET", `/api/queries/${positiveInteger(queryId, "queryId")}`);
  }

  getCachedQueryResult(queryId) {
    return this.request("GET", `/api/queries/${positiveInteger(queryId, "queryId")}/results`);
  }

  executeSavedQuery(queryId, parameters, maxAgeSeconds) {
    return this.request("POST", `/api/queries/${positiveInteger(queryId, "queryId")}/results`, {
      data: { parameters, max_age: maxAgeSeconds },
    });
  }

  getJob(jobId) {
    return this.request("GET", `/api/jobs/${encodeJobId(jobId)}`);
  }

  getQueryResult(resultId) {
    return this.request("GET", `/api/query_results/${positiveInteger(resultId, "resultId")}`);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const queue = [...items];
  const results = [];
  async function worker() {
    while (queue.length) results.push(await mapper(queue.shift()));
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  return results;
}

export function isAllowedRequest(method, path) {
  const upperMethod = method.toUpperCase();
  if (upperMethod === "GET") {
    return [
      /^\/api\/dashboards$/,
      /^\/api\/dashboards\/[A-Za-z0-9_-]+$/,
      /^\/api\/queries\/\d+$/,
      /^\/api\/queries\/\d+\/results$/,
      /^\/api\/jobs\/(?:\d+|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/,
      /^\/api\/query_results\/\d+$/,
    ].some((pattern) => pattern.test(path));
  }
  return upperMethod === "POST" && /^\/api\/queries\/\d+\/results$/.test(path);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function encodeJobId(value) {
  const identifier = String(value).trim();
  if (/^\d+$/.test(identifier) && Number(identifier) > 0) return identifier;
  if (/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(identifier)) {
    return identifier;
  }
  throw new Error("jobId must be a positive integer or UUID");
}

function encodeIdentifier(value, name) {
  const identifier = String(value).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(identifier)) {
    throw new Error(`${name} must be a numeric ID or slug`);
  }
  return encodeURIComponent(identifier);
}
