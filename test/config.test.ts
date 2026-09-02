import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { hashOwnerCode } from "../src/oauth.js";

describe("configuration", () => {
  it("stores dynamic OAuth clients on the existing persistent volume by default", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      MCP_PUBLIC_ORIGIN: "https://mail.example",
      OAUTH_CLIENT_ID: "agent-mail-chatgpt",
      OAUTH_REDIRECT_URI: "https://chatgpt.com/connector/oauth/test-callback",
      OAUTH_OWNER_CODE_HASH: hashOwnerCode("correct-horse-battery-staple-owner"),
      OAUTH_SIGNING_SECRET: "a-different-signing-secret-that-is-long-enough",
    });
    expect(config.oauth.clientsFile).toBe("/data/agently-cli/oauth-clients.json");
    expect(config.clientTokens).toEqual([]);
  });

  it("parses independent named tokens for non-OAuth MCP clients", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      MCP_PUBLIC_ORIGIN: "https://mail.example",
      MCP_CLIENT_TOKENS: `${"polaris"}:${"A".repeat(48)},other-client:${"B".repeat(48)}`,
      OAUTH_CLIENT_ID: "agent-mail-chatgpt",
      OAUTH_REDIRECT_URI: "https://chatgpt.com/connector/oauth/test-callback",
      OAUTH_OWNER_CODE_HASH: hashOwnerCode("correct-horse-battery-staple-owner"),
      OAUTH_SIGNING_SECRET: "a-different-signing-secret-that-is-long-enough",
    });
    expect(config.clientTokens).toEqual([
      { clientId: "polaris", token: "A".repeat(48) },
      { clientId: "other-client", token: "B".repeat(48) },
    ]);
  });

  it("rejects malformed, duplicate, and reused MCP client tokens", () => {
    const base = {
      NODE_ENV: "production",
      MCP_PUBLIC_ORIGIN: "https://mail.example",
      OAUTH_CLIENT_ID: "agent-mail-chatgpt",
      OAUTH_REDIRECT_URI: "https://chatgpt.com/connector/oauth/test-callback",
      OAUTH_OWNER_CODE_HASH: hashOwnerCode("correct-horse-battery-staple-owner"),
      OAUTH_SIGNING_SECRET: "a-different-signing-secret-that-is-long-enough",
    };
    expect(() => loadConfig({ ...base, MCP_CLIENT_TOKENS: "missing-separator" }))
      .toThrow("client-id:token");
    expect(() => loadConfig({
      ...base,
      MCP_CLIENT_TOKENS: `one:${"A".repeat(48)},two:${"A".repeat(48)}`,
    })).toThrow("must be unique");
    expect(() => loadConfig({
      ...base,
      MCP_CLIENT_TOKENS: `polaris:${base.OAUTH_SIGNING_SECRET}`,
    })).toThrow("must be independent");
  });
});
