export const OPERATIONS = [
  'getObjectSchema',
  'soqlQuery',
  'find',
  'getUserInfo',
  'listRecentSobjectRecords',
  'getRelatedRecords',
] as const;
export type Operation = (typeof OPERATIONS)[number];

export type AdapterErrorCode =
  | 'AUTH_UNAVAILABLE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'UNSUPPORTED_OBJECT_OR_FIELD'
  | 'INVALID_QUERY'
  | 'INVALID_INPUT'
  | 'RESPONSE_LIMIT_EXCEEDED'
  | 'FORBIDDEN_OPERATION';

export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode) {
    super(code);
    this.name = 'AdapterError';
  }
}

export interface TokenValue {
  accessToken: string;
  generation: number;
}

export interface TokenMetrics {
  tokenAcquisitions: number;
  tokenGenerations: number;
  tokenCacheHits: number;
  tokenCoalescedWaiters: number;
  tokenInvalidations: number;
}

export interface AdapterMetrics extends TokenMetrics {
  salesforce401Retries: number;
  activeRequests: number;
  maxConcurrentRequests: number;
}

export class TokenManager {
  private current: { accessToken: string; generation: number; issuedAt: number } | undefined;
  private pending: Promise<TokenValue> | undefined;
  private generation = 0;
  private acquisitions = 0;
  private cacheHits = 0;
  private coalescedWaiters = 0;
  private invalidations = 0;

  constructor(
    private readonly acquireToken: () => Promise<string>,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<TokenValue> {
    if (this.current && this.now() - this.current.issuedAt < this.maxAgeMs) {
      this.cacheHits += 1;
      return { accessToken: this.current.accessToken, generation: this.current.generation };
    }
    if (this.pending) {
      this.coalescedWaiters += 1;
      return this.pending;
    }
    this.pending = this.refresh();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  invalidate(generation: number): void {
    if (this.current?.generation === generation) {
      this.current = undefined;
      this.invalidations += 1;
    }
  }

  metrics(): TokenMetrics {
    return {
      tokenAcquisitions: this.acquisitions,
      tokenGenerations: this.generation,
      tokenCacheHits: this.cacheHits,
      tokenCoalescedWaiters: this.coalescedWaiters,
      tokenInvalidations: this.invalidations,
    };
  }

  private async refresh(): Promise<TokenValue> {
    let accessToken: string;
    try {
      this.acquisitions += 1;
      accessToken = await this.acquireToken();
    } catch {
      throw new AdapterError('AUTH_UNAVAILABLE');
    }
    if (!accessToken) throw new AdapterError('AUTH_UNAVAILABLE');
    this.generation += 1;
    this.current = { accessToken, generation: this.generation, issuedAt: this.now() };
    return { accessToken, generation: this.generation };
  }
}

export interface AdapterConfig {
  salesforceOrigin: string;
  apiVersion: string;
  maxResponseBytes: number;
  maxRows: number;
  maxPages: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
}

type JsonObject = Record<string, unknown>;
type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const RELATIONSHIP_PATH = /^[A-Za-z][A-Za-z0-9_]{0,127}(?:\/[A-Za-z][A-Za-z0-9_]{0,127}){0,4}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export class SalesforceAdapter {
  private readonly origin: URL;
  private activeRequests = 0;
  private peakActiveRequests = 0;
  private salesforce401Retries = 0;

  constructor(
    private readonly config: AdapterConfig,
    private readonly tokens: TokenManager,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.origin = new URL(config.salesforceOrigin);
    if (this.origin.protocol !== 'https:' || this.origin.pathname !== '/' || this.origin.search || this.origin.hash) {
      throw new Error('Salesforce origin must be an exact HTTPS origin');
    }
    if (!/^v\d{2}\.\d$/.test(config.apiVersion)) throw new Error('Invalid Salesforce API version');
  }

  async execute(operation: string, input: unknown): Promise<unknown> {
    if (this.activeRequests >= this.config.maxConcurrentRequests) throw new AdapterError('RATE_LIMITED');
    this.activeRequests += 1;
    this.peakActiveRequests = Math.max(this.peakActiveRequests, this.activeRequests);
    try {
      return await this.executeBounded(operation, input);
    } finally {
      this.activeRequests -= 1;
    }
  }

  metrics(): AdapterMetrics {
    return {
      ...this.tokens.metrics(),
      salesforce401Retries: this.salesforce401Retries,
      activeRequests: this.activeRequests,
      maxConcurrentRequests: this.peakActiveRequests,
    };
  }

  private async executeBounded(operation: string, input: unknown): Promise<unknown> {
    if (!OPERATIONS.includes(operation as Operation)) throw new AdapterError('FORBIDDEN_OPERATION');
    const args = objectInput(input);
    switch (operation as Operation) {
      case 'getObjectSchema': {
        exactKeys(args, [], ['object-name', 'objects', 'sobject-name']);
        const objectName = optionalAliasedApiName(args, ['object-name', 'objects', 'sobject-name']);
        return this.getJson(objectName ? this.apiPath(`/sobjects/${objectName}/describe`) : this.apiPath('/sobjects/'));
      }
      case 'soqlQuery': {
        exactKeys(args, [], ['query', 'q']);
        const query = requiredAliasedString(args, ['query', 'q'], 10_000);
        validateSoql(query);
        return this.getPaginated(this.apiPath(`/query?q=${encodeURIComponent(query)}`));
      }
      case 'find': {
        exactKeys(args, [], ['search', 'q']);
        const search = requiredAliasedString(args, ['search', 'q'], 10_000);
        validateSosl(search);
        const result = (await this.getJson(this.apiPath(`/search?q=${encodeURIComponent(search)}`))) as JsonObject;
        const records = Array.isArray(result.searchRecords) ? result.searchRecords.slice(0, this.config.maxRows) : [];
        return {
          ...result,
          searchRecords: records,
          truncated: Array.isArray(result.searchRecords) && result.searchRecords.length > records.length,
        };
      }
      case 'getUserInfo':
        exactKeys(args, []);
        return this.getJson('/services/oauth2/userinfo');
      case 'listRecentSobjectRecords': {
        exactKeys(args, ['sobject-name']);
        const name = requiredApiName(args['sobject-name']);
        const recent = (await this.getJson(this.apiPath('/recent/?limit=200'))) as unknown[];
        return recent.filter((item) => recordType(item) === name).slice(0, this.config.maxRows);
      }
      case 'getRelatedRecords': {
        exactKeys(args, ['sobject-name', 'id', 'relationship-path']);
        const name = requiredApiName(args['sobject-name']);
        const id = requiredString(args.id, 18);
        if (!RECORD_ID.test(id)) throw new AdapterError('INVALID_INPUT');
        const relationship = requiredString(args['relationship-path'], 644);
        if (!RELATIONSHIP_PATH.test(relationship)) throw new AdapterError('INVALID_INPUT');
        return this.getPaginated(this.apiPath(`/sobjects/${name}/${id}/${relationship}`));
      }
    }
  }

  async readiness(): Promise<boolean> {
    try {
      await this.getJson('/services/oauth2/userinfo');
      return true;
    } catch {
      return false;
    }
  }

  private apiPath(suffix: string): string {
    return `/services/data/${this.config.apiVersion}${suffix}`;
  }

  private async getPaginated(initialPath: string): Promise<JsonObject> {
    let path = initialPath;
    const records: unknown[] = [];
    let totalSize: unknown;
    for (let page = 0; page < this.config.maxPages; page += 1) {
      const result = (await this.getJson(path)) as JsonObject;
      totalSize ??= result.totalSize;
      const next = Array.isArray(result.records) ? result.records : [];
      const remaining = Math.max(0, this.config.maxRows - records.length);
      const pageWasSliced = next.length > remaining;
      records.push(...next.slice(0, remaining));
      if (result.done === true || records.length >= this.config.maxRows) {
        const truncated = pageWasSliced || result.done !== true;
        return { totalSize, done: result.done === true && !truncated, truncated, records };
      }
      if (typeof result.nextRecordsUrl !== 'string' || !result.nextRecordsUrl.startsWith('/services/data/')) {
        throw new AdapterError('UPSTREAM_UNAVAILABLE');
      }
      path = result.nextRecordsUrl;
    }
    return { totalSize, done: false, truncated: true, records };
  }

  private async getJson(path: string, retry = true): Promise<unknown> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin.origin || url.protocol !== 'https:') throw new AdapterError('FORBIDDEN_OPERATION');
    const token = await this.tokens.get();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token.accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new AdapterError('UPSTREAM_TIMEOUT');
      throw new AdapterError('UPSTREAM_UNAVAILABLE');
    }
    if (response.status === 401 && retry) {
      this.salesforce401Retries += 1;
      this.tokens.invalidate(token.generation);
      return this.getJson(path, false);
    }
    if (response.status === 429) throw new AdapterError('RATE_LIMITED');
    if (!response.ok) {
      if (response.status === 401) throw new AdapterError('AUTH_UNAVAILABLE');
      const errorBody = await readBounded(response, this.config.maxResponseBytes);
      throw new AdapterError(classifySalesforceError(response.status, errorBody));
    }
    const text = await readBounded(response, this.config.maxResponseBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AdapterError('UPSTREAM_UNAVAILABLE');
    }
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AdapterError('RESPONSE_LIMIT_EXCEEDED');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function objectInput(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('INVALID_INPUT');
  return value as JsonObject;
}

function exactKeys(input: JsonObject, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new AdapterError('INVALID_INPUT');
  if (required.some((key) => !(key in input))) throw new AdapterError('INVALID_INPUT');
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength)
    throw new AdapterError('INVALID_INPUT');
  return value;
}

function requiredApiName(value: unknown): string {
  const name = requiredString(value, 128);
  if (!API_NAME.test(name)) throw new AdapterError('INVALID_INPUT');
  return name;
}

function requiredAliasedString(input: JsonObject, names: string[], maxLength: number): string {
  const present = names.filter((name) => name in input);
  if (present.length === 0) throw new AdapterError('INVALID_INPUT');
  const values = present.map((name) => requiredString(input[name], maxLength));
  if (new Set(values).size !== 1) throw new AdapterError('INVALID_INPUT');
  return values[0]!;
}

function optionalAliasedApiName(input: JsonObject, names: string[]): string | undefined {
  const present = names.filter((name) => name in input);
  if (present.length === 0) return undefined;
  const values = present.map((name) => requiredApiName(input[name]));
  if (new Set(values).size !== 1) throw new AdapterError('INVALID_INPUT');
  return values[0];
}

function validateSoql(query: string): void {
  const normalized = query.trim();
  if (normalized.includes(';') || /\/\*|\*\/|--|\/\//.test(normalized)) throw new AdapterError('FORBIDDEN_OPERATION');
  const tokens = topLevelSoqlTokens(normalized);
  if (tokens[0] !== 'SELECT' || !tokens.includes('FROM')) throw new AdapterError('INVALID_INPUT');
  if (!tokens.includes('WHERE') && !tokens.includes('LIMIT') && !hasTopLevelAggregate(normalized)) {
    throw new AdapterError('INVALID_INPUT');
  }
  if (tokens.includes('FOR')) throw new AdapterError('FORBIDDEN_OPERATION');
}

function hasTopLevelAggregate(query: string): boolean {
  const aggregateFunctions = new Set(['AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX', 'SUM']);
  let token = '';
  let lastToken = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  const flush = (): string => {
    if (token) lastToken = token.toUpperCase();
    token = '';
    return lastToken;
  };

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === "'") {
        if (query[index + 1] === "'") index += 1;
        else inString = false;
      }
      continue;
    }
    if (character === "'") {
      token = '';
      lastToken = '';
      inString = true;
      continue;
    }
    if (character === '(') {
      const functionName = token ? token.toUpperCase() : lastToken;
      if (depth === 0 && aggregateFunctions.has(functionName)) return true;
      flush();
      lastToken = '';
      depth += 1;
      continue;
    }
    if (character === ')') {
      token = '';
      lastToken = '';
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && /[A-Za-z0-9_]/.test(character)) {
      token += character;
      continue;
    }
    if (depth === 0) {
      if (flush() === 'FROM') return false;
      if (!/\s/.test(character)) lastToken = '';
    }
  }
  return false;
}

function topLevelSoqlTokens(query: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  const flush = (): void => {
    if (token) tokens.push(token.toUpperCase());
    token = '';
  };

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === "'") {
        if (query[index + 1] === "'") index += 1;
        else inString = false;
      }
      continue;
    }
    if (character === "'") {
      flush();
      inString = true;
      continue;
    }
    if (character === '(') {
      flush();
      depth += 1;
      continue;
    }
    if (character === ')') {
      flush();
      if (depth === 0) throw new AdapterError('INVALID_INPUT');
      depth -= 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z0-9_]/.test(character)) token += character;
    else flush();
  }
  if (inString || depth !== 0) throw new AdapterError('INVALID_INPUT');
  flush();
  return tokens;
}

function validateSosl(search: string): void {
  const normalized = search.trim();
  if (!/^FIND\s*\{/i.test(normalized) || !/\bRETURNING\b/i.test(normalized) || normalized.includes(';')) {
    throw new AdapterError('INVALID_INPUT');
  }
}

function recordType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const attributes = (value as JsonObject).attributes;
  return attributes && typeof attributes === 'object' ? String((attributes as JsonObject).type || '') : undefined;
}

function classifySalesforceError(status: number, body: string): AdapterErrorCode {
  const code = salesforceErrorCode(body);
  if (status === 403 || code === 'INSUFFICIENT_ACCESS' || code === 'INSUFFICIENT_ACCESS_OR_READONLY') {
    return 'ACCESS_DENIED';
  }
  if (
    code === 'INVALID_TYPE' ||
    code === 'INVALID_FIELD' ||
    code === 'INVALID_TYPE_FOR_OPERATION' ||
    code === 'NOT_FOUND'
  ) {
    return 'UNSUPPORTED_OBJECT_OR_FIELD';
  }
  if (code === 'MALFORMED_QUERY' || code === 'MALFORMED_SEARCH') return 'INVALID_QUERY';
  return 'UPSTREAM_UNAVAILABLE';
}

function salesforceErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!candidate || typeof candidate !== 'object') return undefined;
    const code = (candidate as JsonObject).errorCode;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}
