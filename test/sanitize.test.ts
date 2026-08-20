import { describe, expect, it } from "vitest";

import { parseCliResponse, sanitizeJson } from "../src/sanitize.js";

describe("sanitizeJson", () => {
  it("removes credential-shaped fields recursively", () => {
    expect(sanitizeJson({
      id: "msg_12345678",
      access_token: "secret-a",
      nested: { refreshToken: "secret-b", body: "hello" },
    })).toEqual({
      id: "msg_12345678",
      nested: { body: "hello" },
    });
  });

  it("unwraps a successful CLI envelope", () => {
    expect(parseCliResponse(JSON.stringify({ ok: true, data: { alias: "linxing" } })))
      .toEqual({ alias: "linxing" });
  });

  it("rejects malformed and failed envelopes without returning their body", () => {
    expect(() => parseCliResponse("not-json")).toThrow("INVALID_RESPONSE");
    expect(() => parseCliResponse(JSON.stringify({ ok: false, error: "token=do-not-leak" })))
      .toThrow("UPSTREAM_FAILURE");
  });
});

