import axios from "axios";

import { sanitizeAircall, summarizeCall } from "./sanitize.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_WINDOW_DAYS = 31;

export class AircallError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AircallError";
    this.status = status;
  }
}

export class AircallClient {
  constructor({
    baseUrl,
    allowedHost = "api.aircall.io",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxWindowDays = DEFAULT_MAX_WINDOW_DAYS,
  }) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.hostname !== allowedHost) {
      throw new Error(`AIRCALL_URL must use https and host ${allowedHost}`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("AIRCALL_URL must not contain credentials, a query string, or a fragment");
    }
    this.basePath = url.pathname.replace(/\/$/, "") || "/v1";
    if (this.basePath !== "/v1") throw new Error("AIRCALL_URL path must be /v1 or empty");
    this.maxWindowDays = maxWindowDays;
    this.http = axios.create({
      baseURL: url.origin,
      timeout: timeoutMs,
      maxContentLength: maxResponseBytes,
      maxBodyLength: maxResponseBytes,
      headers: { Accept: "application/json" },
      validateStatus: () => true,
    });
  }

  async request(method, path, { params } = {}) {
    if (!isAllowedRequest(method, path)) {
      throw new Error(`Blocked Aircall API operation: ${method.toUpperCase()} ${path}`);
    }

    let response;
    try {
      response = await this.http.request({ method, url: path, params });
    } catch (error) {
      const reason = error?.code === "ECONNABORTED" ? "request timed out" : "request failed";
      throw new AircallError(`Aircall ${reason}`);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AircallError(`Aircall API returned HTTP ${response.status}`, response.status);
    }
    return response.data;
  }

  ping() {
    return this.request("GET", "/v1/ping");
  }

  async listCalls(options = {}) {
    const params = buildCallParams(options, { maxWindowDays: this.maxWindowDays });
    const needsSearch = Boolean(params.direction || params.user_id || params.phone_number || params.tags);
    const data = await this.request("GET", needsSearch ? "/v1/calls/search" : "/v1/calls", { params });
    return {
      meta: data.meta,
      calls: (data.calls ?? []).map(summarizeCall),
      privacy: privacyNotice(),
    };
  }

  async getCall(callId, options = {}) {
    const data = await this.request("GET", `/v1/calls/${positiveInteger(callId, "callId")}`, {
      params: {
        fetch_contact: booleanParam(options.fetchContact),
        fetch_short_urls: false,
        fetch_call_timeline: booleanParam(options.fetchCallTimeline),
        fetch_aiva_conv: booleanParam(options.fetchAivaConv),
      },
    });
    return {
      call: sanitizeAircall(data.call ?? data, { includeSensitive: Boolean(options.includeSensitive) }),
      privacy: privacyNotice(Boolean(options.includeSensitive)),
    };
  }

  async getCallIntelligence(callId, include = {}) {
    const id = positiveInteger(callId, "callId");
    const requested = {
      transcription: include.transcription ?? true,
      sentiments: include.sentiments ?? true,
      predicted_csat: include.predictedCsat ?? false,
      topics: include.topics ?? true,
      summary: include.summary ?? true,
      custom_summary_result: include.customSummary ?? false,
      action_items: include.actionItems ?? true,
      playbook_result: include.playbookResult ?? false,
      evaluations: include.evaluations ?? false,
    };
    const results = {};
    for (const [name, enabled] of Object.entries(requested)) {
      if (!enabled) continue;
      try {
        results[name] = sanitizeAircall(await this.request("GET", `/v1/calls/${id}/${name}`));
      } catch (error) {
        if (error instanceof AircallError && [403, 404].includes(error.status)) {
          results[name] = { unavailable: true, status: error.status, reason: error.message };
        } else {
          throw error;
        }
      }
    }
    return {
      call_id: id,
      results,
      privacy: {
        ...privacyNotice(),
        scope: "single-call conversation intelligence only; no bulk transcript export",
      },
    };
  }

  async listUsers(options = {}) {
    const data = await this.request("GET", "/v1/users", {
      params: boundedPageParams(options),
    });
    return sanitizeAircall(data);
  }

  async listNumbers(options = {}) {
    const data = await this.request("GET", "/v1/numbers", {
      params: boundedPageParams(options),
    });
    return sanitizeAircall(data);
  }

  async listTags(options = {}) {
    const data = await this.request("GET", "/v1/tags", {
      params: boundedPageParams(options),
    });
    return sanitizeAircall(data);
  }

  async listTeams(options = {}) {
    const data = await this.request("GET", "/v1/teams", {
      params: boundedPageParams(options),
    });
    return sanitizeAircall(data);
  }
}

export function isAllowedRequest(method, path) {
  if (method.toUpperCase() !== "GET") return false;
  return [
    /^\/v1\/ping$/,
    /^\/v1\/calls$/,
    /^\/v1\/calls\/search$/,
    /^\/v1\/calls\/\d+$/,
    /^\/v1\/calls\/\d+\/(?:transcription|sentiments|predicted_csat|topics|summary|custom_summary_result|action_items|playbook_result|evaluations)$/,
    /^\/v1\/users$/,
    /^\/v1\/users\/\d+$/,
    /^\/v1\/numbers$/,
    /^\/v1\/numbers\/\d+$/,
    /^\/v1\/tags$/,
    /^\/v1\/teams$/,
  ].some((pattern) => pattern.test(path));
}

export function buildCallParams(options = {}, { maxWindowDays = DEFAULT_MAX_WINDOW_DAYS } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const lastHours = clampInteger(options.lastHours ?? 24, 1, maxWindowDays * 24, "lastHours");
  const from = toUnixSeconds(options.from, "from") ?? now - lastHours * 3600;
  const to = toUnixSeconds(options.to, "to") ?? now;
  if (to < from) throw new Error("to must be greater than or equal to from");
  if (to - from > maxWindowDays * 86400) {
    throw new Error(`Aircall call window is limited to ${maxWindowDays} days`);
  }

  const params = {
    ...boundedPageParams(options),
    from,
    to,
    order: options.order === "asc" ? "asc" : "desc",
    fetch_contact: false,
    fetch_short_urls: false,
    fetch_call_timeline: booleanParam(options.fetchCallTimeline),
    fetch_aiva_conv: booleanParam(options.fetchAivaConv),
  };
  if (options.direction) {
    if (!["inbound", "outbound"].includes(options.direction)) throw new Error("direction must be inbound or outbound");
    params.direction = options.direction;
  }
  if (options.userId !== undefined) params.user_id = positiveInteger(options.userId, "userId");
  if (options.phoneNumber) params.phone_number = String(options.phoneNumber).trim();
  if (options.tags?.length) params.tags = options.tags.map((tag) => positiveInteger(tag, "tag")).join(",");
  return params;
}

function boundedPageParams(options = {}) {
  return {
    page: clampInteger(options.page ?? 1, 1, 100, "page"),
    per_page: clampInteger(options.perPage ?? 50, 1, 100, "perPage"),
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function clampInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function toUnixSeconds(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Number.isInteger(Number(value)) && Number(value) > 0) return Number(value);
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a UNIX timestamp or parseable date/time`);
  return Math.floor(parsed / 1000);
}

function booleanParam(value) {
  return value === true ? true : false;
}

function privacyNotice(includeSensitive = false) {
  return includeSensitive
    ? { phone_numbers: "included only because includeSensitive was explicitly true", media_urls: "always redacted" }
    : { phone_numbers: "masked", media_urls: "redacted" };
}
