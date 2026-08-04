const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "can",
  "check",
  "dashboard",
  "find",
  "for",
  "in",
  "is",
  "me",
  "of",
  "on",
  "our",
  "please",
  "show",
  "that",
  "the",
  "to",
  "which",
  "you",
]);

const CONCEPTS = {
  hardware: ["firmware", "fw", "gateway", "gateways", "gwy", "sensor", "sensors", "ihd", "ihds", "config", "configuration", "version"],
  firmware: ["firmware", "fw", "version", "upgrade"],
  gateway: ["gateway", "gateways", "gwy"],
  gateways: ["gateway", "gateways", "gwy"],
  sensor: ["sensor", "sensors", "ihd", "ihds"],
  sensors: ["sensor", "sensors", "ihd", "ihds"],
  monitor: ["monitor", "monitoring", "health", "status", "active", "interrupt", "interrupts"],
  monitors: ["monitor", "monitoring", "health", "status", "active", "interrupt", "interrupts"],
  monitoring: ["monitor", "monitoring", "health", "status", "active", "interrupt", "interrupts"],
  configuration: ["config", "configuration", "settings"],
  config: ["config", "configuration", "settings"],
};

export function rankDashboards(query, dashboards, options = {}) {
  const now = options.now ?? new Date();
  const maxAgeDays = boundedInteger(options.maxAgeDays ?? 365, 1, 3650, "maxAgeDays");
  const limit = boundedInteger(options.limit ?? 5, 1, 20, "limit");
  const queryTokens = tokens(query).filter((token) => !STOP_WORDS.has(token));
  if (!queryTokens.length) throw new Error("Dashboard search requires a meaningful name or topic");

  const ranked = dashboards
    .filter((dashboard) => isFresh(dashboard.updated_at, now, maxAgeDays))
    .map((dashboard) => scoreDashboard(queryTokens, dashboard, now, maxAgeDays))
    .filter((candidate) => candidate.coverage > 0)
    .sort(compareCandidates)
    .slice(0, limit);

  return {
    query: String(query).trim(),
    best_match: ranked[0] ?? null,
    confidence: confidence(ranked, queryTokens.length),
    auto_select: shouldAutoSelect(ranked, queryTokens.length),
    candidates: ranked,
  };
}

export function dashboardSearchText(dashboard) {
  const parts = [dashboard.name, dashboard.slug, ...(dashboard.tags ?? [])];
  for (const widget of dashboard.widgets ?? []) {
    parts.push(widget.text);
    const visualization = widget.visualization;
    parts.push(visualization?.name, visualization?.type);
    parts.push(visualization?.query?.name, visualization?.query?.description);
    for (const parameter of visualization?.query?.options?.parameters ?? []) parts.push(parameter?.name);
  }
  return parts.filter((part) => typeof part === "string").join(" ").slice(0, 50_000);
}

function scoreDashboard(queryTokens, dashboard, now, maxAgeDays) {
  const titleTokens = new Set(tokens(`${dashboard.name ?? ""} ${dashboard.slug ?? ""}`));
  const documentTokens = new Set(tokens(dashboard.search_text ?? dashboardSearchText(dashboard)));
  const matched = [];
  let score = 0;

  for (const token of queryTokens) {
    const titleMatch = matchToken(token, titleTokens);
    const documentMatch = matchToken(token, documentTokens);
    const conceptScore = conceptTokenScore(token, titleTokens, documentTokens);
    const best = Math.max(titleMatch ? 12 : 0, documentMatch ? 8 : 0, conceptScore);
    if (best > 0) {
      score += /^\d+$/.test(token) ? best + 6 : best;
      matched.push(token);
    }
  }

  const normalizedName = normalize(dashboard.name);
  const normalizedQuery = normalize(queryTokens.join(" "));
  if (normalizedName === normalizedQuery) score += 30;
  else if (normalizedName.includes(normalizedQuery)) score += 14;

  const ageDays = ageInDays(dashboard.updated_at, now);
  const freshness = Number.isFinite(ageDays) ? Math.max(0, 3 * (1 - ageDays / maxAgeDays)) : 0;
  score += freshness;

  return {
    id: dashboard.id,
    name: dashboard.name,
    slug: dashboard.slug,
    updated_at: dashboard.updated_at,
    tags: Array.isArray(dashboard.tags) ? dashboard.tags.slice(0, 20) : [],
    score: Number(score.toFixed(2)),
    matched_terms: matched,
    coverage: Number((matched.length / queryTokens.length).toFixed(2)),
  };
}

function matchToken(token, documentTokens) {
  if (documentTokens.has(token)) return true;
  if (token.length < 4) return false;
  for (const candidate of documentTokens) {
    if (candidate.length < 4) continue;
    if (candidate.includes(token) || token.includes(candidate)) return true;
    if (similarity(token, candidate) >= 0.8) return true;
  }
  return false;
}

function conceptTokenScore(token, titleTokens, documentTokens) {
  const synonyms = CONCEPTS[token] ?? [];
  if (synonyms.some((synonym) => titleTokens.has(synonym))) return 7;
  if (synonyms.some((synonym) => documentTokens.has(synonym))) return 5;
  return 0;
}

function confidence(ranked, tokenCount) {
  if (shouldAutoSelect(ranked, tokenCount)) return "high";
  if (ranked[0]?.coverage >= 0.5) return "medium";
  return "low";
}

function shouldAutoSelect(ranked, tokenCount) {
  const best = ranked[0];
  if (!best || best.coverage < Math.min(1, 2 / tokenCount) || best.score < 18) return false;
  const second = ranked[1];
  return !second || best.score - second.score >= 6 || best.score >= second.score * 1.25;
}

function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  const updated = String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
  if (updated !== 0) return updated;
  return Number(left.id ?? 0) - Number(right.id ?? 0);
}

function isFresh(value, now, maxAgeDays) {
  const ageDays = ageInDays(value, now);
  return Number.isFinite(ageDays) && ageDays >= -1 && ageDays <= maxAgeDays;
}

function ageInDays(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? (now.getTime() - timestamp) / 86_400_000 : Number.NaN;
}

function tokens(value) {
  return normalize(value).match(/[a-z0-9]+/g) ?? [];
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function similarity(left, right) {
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function levenshtein(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[right.length];
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}
