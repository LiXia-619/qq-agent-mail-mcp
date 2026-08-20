import type { Response } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hashOwnerCode, SingleOwnerOAuthProvider, verifyOwnerCode } from "../src/oauth.js";

const issuerUrl = new URL("https://mail.example/");
const resourceUrl = new URL("https://mail.example/mcp");
const redirectUri = "https://chatgpt.com/connector/oauth/test-callback";
const clientId = "agent-mail-chatgpt";
const ownerCode = "correct-horse-battery-staple-owner";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function clientsFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-mail-oauth-"));
  temporaryDirectories.push(directory);
  return join(directory, "clients.json");
}

function provider(file = clientsFile()) {
  return new SingleOwnerOAuthProvider({
    issuerUrl,
    resourceUrl,
    redirectUri,
    clientId,
    clientsFile: file,
    ownerCodeHash: hashOwnerCode(ownerCode),
    signingSecret: "a-different-signing-secret-that-is-long-enough",
  });
}

describe("single-owner OAuth", () => {
  it("hashes and verifies the owner code", () => {
    const hash = hashOwnerCode(ownerCode);
    expect(verifyOwnerCode(ownerCode, hash)).toBe(true);
    expect(verifyOwnerCode("wrong-owner-code-that-is-long", hash)).toBe(false);
  });

  it("requires owner approval, PKCE-bound one-time codes, and both mail scopes", async () => {
    const oauth = provider();
    const client = await oauth.clientsStore.getClient(clientId);
    expect(client).toBeDefined();
    let approvalRedirect = "";
    const response = {
      redirect: (_status: number, url: string) => { approvalRedirect = url; },
    } as unknown as Response;
    await oauth.authorize(client!, {
      redirectUri,
      codeChallenge: "challenge-value",
      scopes: ["mail:read", "mail:reply"],
      state: "state-1",
      resource: resourceUrl,
    }, response);
    const requestId = new URL(approvalRedirect).searchParams.get("request");
    expect(requestId).toBeTruthy();
    expect(() => oauth.approve(requestId!, "wrong-owner-code-that-is-long")).toThrow("Approval failed");
    const callback = new URL(oauth.approve(requestId!, `  ${ownerCode}\n`));
    const code = callback.searchParams.get("code");
    expect(callback.searchParams.get("state")).toBe("state-1");
    await expect(oauth.challengeForAuthorizationCode(client!, code!)).resolves.toBe("challenge-value");
    const tokens = await oauth.exchangeAuthorizationCode(client!, code!, undefined, redirectUri, resourceUrl);
    const auth = await oauth.verifyAccessToken(tokens.access_token);
    expect(auth.scopes).toEqual(["mail:read", "mail:reply"]);
    expect(auth.resource?.href).toBe(resourceUrl.href);
    await expect(oauth.exchangeAuthorizationCode(client!, code!, undefined, redirectUri, resourceUrl))
      .rejects.toThrow("Invalid authorization code");

    const repeatedCallback = new URL(oauth.approve(requestId!, ownerCode));
    const repeatedCode = repeatedCallback.searchParams.get("code");
    expect(repeatedCode).not.toBe(code);
    const repeatedTokens = await oauth.exchangeAuthorizationCode(
      client!,
      repeatedCode!,
      undefined,
      redirectUri,
      resourceUrl,
    );
    await expect(oauth.verifyAccessToken(repeatedTokens.access_token)).resolves.toMatchObject({
      clientId,
      scopes: ["mail:read", "mail:reply"],
    });
  });

  it("persists a public ChatGPT client and accepts it after a restart", async () => {
    const file = clientsFile();
    const first = provider(file);
    const dynamicClient = await first.clientsStore.registerClient!({
      redirect_uris: ["https://chatgpt.com/connector/oauth/dynamic-callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT Agent Mail",
      scope: "mail:read mail:reply",
    });
    expect(dynamicClient.client_id).not.toBe(clientId);

    const restarted = provider(file);
    const restored = await restarted.clientsStore.getClient(dynamicClient.client_id);
    expect(restored).toMatchObject({
      client_id: dynamicClient.client_id,
      redirect_uris: ["https://chatgpt.com/connector/oauth/dynamic-callback"],
      token_endpoint_auth_method: "none",
    });

    let approvalRedirect = "";
    const response = {
      redirect: (_status: number, url: string) => { approvalRedirect = url; },
    } as unknown as Response;
    await restarted.authorize(restored!, {
      redirectUri: restored!.redirect_uris[0]!,
      codeChallenge: "dynamic-challenge",
      scopes: ["mail:read", "mail:reply"],
      resource: resourceUrl,
    }, response);
    const requestId = new URL(approvalRedirect).searchParams.get("request");
    const code = new URL(restarted.approve(requestId!, ownerCode)).searchParams.get("code");
    const tokens = await restarted.exchangeAuthorizationCode(
      restored!,
      code!,
      undefined,
      restored!.redirect_uris[0],
      resourceUrl,
    );
    await expect(restarted.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
      clientId: dynamicClient.client_id,
      scopes: ["mail:read", "mail:reply"],
    });
  });

  it("rejects dynamic clients outside the ChatGPT public-client boundary", async () => {
    const oauth = provider();
    expect(() => oauth.clientsStore.registerClient!({
      redirect_uris: ["https://attacker.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "mail:read mail:reply",
    })).toThrow("ChatGPT connector callbacks");
    expect(() => oauth.clientsStore.registerClient!({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "mail:read mail:reply",
    })).toThrow("public OAuth clients");
  });

  it("does not issue a connector token without reply scope", async () => {
    const oauth = provider();
    const client = await oauth.clientsStore.getClient(clientId);
    let approvalRedirect = "";
    const response = {
      redirect: (_status: number, url: string) => { approvalRedirect = url; },
    } as unknown as Response;
    await oauth.authorize(client!, {
      redirectUri,
      codeChallenge: "challenge-value",
      scopes: ["mail:read"],
      resource: resourceUrl,
    }, response);
    const requestId = new URL(approvalRedirect).searchParams.get("request");
    const code = new URL(oauth.approve(requestId!, ownerCode)).searchParams.get("code");
    await expect(oauth.exchangeAuthorizationCode(client!, code!, undefined, redirectUri, resourceUrl))
      .rejects.toThrow("Both mail:read and mail:reply scopes are required");
  });

  it("denies a mismatched resource", async () => {
    const oauth = provider();
    const client = await oauth.clientsStore.getClient(clientId);
    const response = { redirect: () => undefined } as unknown as Response;
    await expect(oauth.authorize(client!, {
      redirectUri,
      codeChallenge: "challenge-value",
      scopes: ["mail:read"],
      resource: new URL("https://attacker.example/mcp"),
    }, response)).rejects.toThrow("Invalid OAuth resource");
  });
});

