import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { AgentlyWebAuth, extractAuthorizationUrl } from "../src/agently-web-auth.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-auth.mjs", import.meta.url));

describe("AgentlyWebAuth", () => {
  beforeAll(() => chmodSync(fixture, 0o755));

  it("accepts only Tencent's exact device-authorization URL", () => {
    expect(extractAuthorizationUrl(
      "go to https://agent.qq.com/page/oauth?oauth_type=device&user_code=uc_test",
    )).toContain("user_code=uc_test");
    expect(extractAuthorizationUrl(
      "https://attacker.example/page/oauth?oauth_type=device&user_code=uc_test",
    )).toBeUndefined();
    expect(extractAuthorizationUrl(
      "https://agent.qq.com.evil.example/page/oauth?oauth_type=device&user_code=uc_test",
    )).toBeUndefined();
  });

  it("keeps the device login alive outside a terminal and detects completion", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "agent-mail-web-auth-"));
    const auth = new AgentlyWebAuth({
      binary: fixture,
      configDir,
      workspace: "default",
      timeoutMs: 5_000,
    });
    const started = await auth.start();
    expect(started).toMatchObject({
      state: "awaiting_authorization",
      authorizationUrl: expect.stringContaining("agent.qq.com/page/oauth"),
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    await expect(auth.status()).resolves.toMatchObject({ state: "authorized" });
  });
});

