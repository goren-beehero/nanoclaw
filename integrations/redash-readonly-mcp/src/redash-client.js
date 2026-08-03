import axios from "axios";

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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }) {
    const url = new URL(baseUrl);
    const localTestHost = allowInsecureLocalhost && ["127.0.0.1", "localhost"].includes(url.hostname);
    if (!localTestHost && (url.protocol !== "https:" || url.hostname !== allowedHost)) {
      throw new Error(`REDASH_URL must be https://${allowedHost}`);
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
    return this.request("GET", `/api/jobs/${positiveInteger(jobId, "jobId")}`);
  }

  getQueryResult(resultId) {
    return this.request("GET", `/api/query_results/${positiveInteger(resultId, "resultId")}`);
  }
}

export function isAllowedRequest(method, path) {
  const upperMethod = method.toUpperCase();
  if (upperMethod === "GET") {
    return [
      /^\/api\/dashboards\/[A-Za-z0-9_-]+$/,
      /^\/api\/queries\/\d+$/,
      /^\/api\/queries\/\d+\/results$/,
      /^\/api\/jobs\/\d+$/,
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

function encodeIdentifier(value, name) {
  const identifier = String(value).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(identifier)) {
    throw new Error(`${name} must be a numeric ID or slug`);
  }
  return encodeURIComponent(identifier);
}
