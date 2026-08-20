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
  });
});

