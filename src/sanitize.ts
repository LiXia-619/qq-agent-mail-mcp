import { AgentMailError, type JsonValue } from "./types.js";

const SECRET_KEY =
  /(?:^|_)(?:access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password|credential|client[_-]?secret)(?:$|_)/i;
const MAX_DEPTH = 16;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_OBJECT_KEYS = 500;
const MAX_STRING_LENGTH = 512_000;

export function sanitizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) {
    return "[truncated:depth]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}\n[truncated]`;
    }
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      if (SECRET_KEY.test(key)) {
        continue;
      }
      result[key] = sanitizeJson(item, depth + 1);
    }
    return result;
  }
  return null;
}

export function parseCliResponse(stdout: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new AgentMailError("INVALID_RESPONSE", { cause });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentMailError("INVALID_RESPONSE");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.ok !== true) {
    const text = JSON.stringify(parsed).toLowerCase();
    const code = text.includes("login") || text.includes("auth")
      ? "AUTH_REQUIRED"
      : "UPSTREAM_FAILURE";
    throw new AgentMailError(code);
  }
  return sanitizeJson(envelope.data ?? {});
}

