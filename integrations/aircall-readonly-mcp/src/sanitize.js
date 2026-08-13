const PHONE_KEYS = new Set(["raw_digits", "digits", "phone_number"]);
const MEDIA_KEYS = new Set(["recording", "voicemail", "asset"]);

export function sanitizeAircall(value, { includeSensitive = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => sanitizeAircall(item, { includeSensitive }));
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (!includeSensitive && PHONE_KEYS.has(key)) {
      output[key] = maskPhone(child);
      continue;
    }
    if (MEDIA_KEYS.has(key)) {
      output[key] = mediaPlaceholder(child);
      continue;
    }
    if (!includeSensitive && key === "direct_link" && typeof child === "string") {
      output[key] = child.replace(/^https:\/\/api\.aircall\.io\/v1\//, "aircall:/");
      continue;
    }
    output[key] = sanitizeAircall(child, { includeSensitive });
  }
  return output;
}

export function summarizeCall(call) {
  const sanitized = sanitizeAircall(call);
  return {
    id: sanitized.id,
    sid: sanitized.sid,
    direction: sanitized.direction,
    status: sanitized.status,
    missed_call_reason: sanitized.missed_call_reason,
    started_at: sanitized.started_at,
    answered_at: sanitized.answered_at,
    ended_at: sanitized.ended_at,
    duration: sanitized.duration,
    raw_digits: sanitized.raw_digits,
    user: compactUser(sanitized.user),
    assigned_to: compactUser(sanitized.assigned_to),
    number: compactNumber(sanitized.number),
    teams: Array.isArray(sanitized.teams) ? sanitized.teams.map((team) => ({ id: team.id, name: team.name })) : [],
    tags: Array.isArray(sanitized.tags) ? sanitized.tags.map((tag) => ({ id: tag.id, name: tag.name })) : [],
    comments_count: Array.isArray(sanitized.comments) ? sanitized.comments.length : undefined,
    has_recording: hasMedia(call.recording),
    has_voicemail: hasMedia(call.voicemail),
    has_asset: hasMedia(call.asset),
    archived: sanitized.archived,
  };
}

function compactUser(user) {
  if (!user) return user ?? null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    availability_status: user.availability_status,
    time_zone: user.time_zone,
  };
}

function compactNumber(number) {
  if (!number) return number ?? null;
  return {
    id: number.id,
    name: number.name,
    country: number.country,
    time_zone: number.time_zone,
    digits: number.digits,
    availability_status: number.availability_status,
    is_ivr: number.is_ivr,
  };
}

function maskPhone(value) {
  if (value == null || value === "") return value;
  const text = String(value);
  const digits = text.replace(/\D/g, "");
  if (!digits) return "[redacted-phone]";
  const suffix = digits.slice(-4);
  const prefix = text.trim().startsWith("+") ? "+" : "";
  return `${prefix}***${suffix}`;
}

function mediaPlaceholder(value) {
  if (!hasMedia(value)) return value ?? null;
  return { available: true, redacted: "media-url" };
}

function hasMedia(value) {
  return value !== null && value !== undefined && value !== "";
}
