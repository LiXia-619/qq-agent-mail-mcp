import request from "supertest";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { MailboxAuthController, MailboxAuthSnapshot } from "../src/agently-web-auth.js";
import type { AppConfig } from "../src/config.js";
import { createHttpApp } from "../src/http-app.js";
import { hashOwnerCode } from "../src/oauth.js";
import type { AgentMailClient, JsonValue } from "../src/types.js";

const ownerCode = "correct-horse-battery-staple-owner";
const fakeMail: AgentMailClient = {
  async query(action, params): Promise<JsonValue> { return { action, params }; },
  async execute(action, params): Promise<JsonValue> { return { action, params }; },
};

class FakeMailboxAuth implements MailboxAuthController {
  starts = 0;
  snapshot: MailboxAuthSnapshot = { state: "idle", updatedAt: new Date().toISOString() };
  async status() { return this.snapshot; }
  async start() {
    this.starts += 1;
    this.snapshot = {
      state: "awaiting_authorization",
      authorizationUrl: "https://agent.qq.com/page/oauth?oauth_type=device&user_code=uc_test",
      updatedAt: new Date().toISOString(),
    };
    return this.snapshot;
  }
}

const config: AppConfig = {
  bindHost: "0.0.0.0",
  port: 3000,
  publicOrigin: new URL("https://mail.example/"),
  mcpServerUrl: new URL("https://mail.example/mcp"),
  allowedHosts: ["mail.example"],
  clientTokens: [],
  oauth: {
    clientId: "agent-mail-chatgpt",
    redirectUri: "https://chatgpt.com/connector/oauth/test-callback",
    clientsFile: "/tmp/agent-mail-http-test-clients.json",
    ownerCodeHash: hashOwnerCode(ownerCode),
    signingSecret: "a-different-signing-secret-that-is-long-enough",
  },
  agently: {
    binary: "agently-cli",
    configDir: "/data/agently-cli",
    workspace: "default",
    timeoutMs: 20_000,
  },
};

function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/);
  if (!match?.[1]) throw new Error("missing csrf");
  return match[1];
}

describe("HTTP security boundary", () => {
  it("exposes only a minimal health check", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    await request(app).get("/healthz").set("Host", "mail.example")
      .expect(200, { ok: true, service: "agent-mail-gateway", version: "0.5.1" });
  });

  it("does not expose the mailbox authorization link before owner verification", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    const page = await request(app).get("/setup").set("Host", "mail.example").expect(200);
    expect(page.text).not.toContain("agent.qq.com");
    await request(app)
      .post("/setup/session")
      .set("Host", "mail.example")
      .type("form")
      .send({ owner_code: "wrong-owner-code-that-is-long" })
      .expect(401);
  });

  it("does not rate-limit successful page views", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await request(app).get("/setup").set("Host", "mail.example").expect(200);
    }
  });

  it("starts browser OAuth only inside an owner session with CSRF protection", async () => {
    const mailboxAuth = new FakeMailboxAuth();
    const app = createHttpApp(config, fakeMail, mailboxAuth);
    const login = await request(app)
      .post("/setup/session")
      .set("Host", "mail.example")
      .type("form")
      .send({ owner_code: ownerCode })
      .expect(303);
    const setCookie = login.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(cookieHeader).toBeTruthy();
    const setup = await request(app)
      .get("/setup")
      .set("Host", "mail.example")
      .set("Cookie", cookieHeader!)
      .expect(200);
    const csrf = csrfFrom(setup.text);
    await request(app)
      .post("/setup/login")
      .set("Host", "mail.example")
      .set("Cookie", cookieHeader!)
      .type("form")
      .send({ csrf: "wrong" })
      .expect(403);
    await request(app)
      .post("/setup/login")
      .set("Host", "mail.example")
      .set("Cookie", cookieHeader!)
      .type("form")
      .send({ csrf })
      .expect(303);
    expect(mailboxAuth.starts).toBe(1);
    const awaiting = await request(app)
      .get("/setup")
      .set("Host", "mail.example")
      .set("Cookie", cookieHeader!)
      .expect(200);
    expect(awaiting.text).toContain("https://agent.qq.com/page/oauth?");
  });

  it("publishes OAuth metadata and rejects unauthenticated MCP calls", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    const metadata = await request(app)
      .get("/.well-known/oauth-protected-resource/mcp")
      .set("Host", "mail.example")
      .expect(200);
    expect(metadata.body).toMatchObject({
      resource: "https://mail.example/mcp",
      authorization_servers: ["https://mail.example/"],
      scopes_supported: ["mail:read", "mail:reply"],
    });
    const authorizationMetadata = await request(app)
      .get("/.well-known/oauth-authorization-server")
      .set("Host", "mail.example")
      .expect(200);
    expect(authorizationMetadata.body).toMatchObject({
      registration_endpoint: "https://mail.example/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
    });
    await request(app)
      .post("/register")
      .set("Host", "mail.example")
      .send({
        redirect_uris: ["https://chatgpt.com/connector/oauth/dcr-test"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mail:read mail:reply",
      })
      .expect(201)
      .expect((response) => {
        expect(response.body.client_id).toEqual(expect.any(String));
        expect(response.body.client_secret).toBeUndefined();
      });
    await request(app)
      .post("/mcp")
      .set("Host", "mail.example")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);
    await request(app)
      .post("/mcp")
      .set("Host", "mail.example")
      .set("Authorization", `Bearer ${"X".repeat(48)}`)
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);
    await request(app).get("/sse").set("Host", "mail.example").expect(401);
    await request(app).post("/messages?sessionId=unknown").set("Host", "mail.example").expect(401);
  });

  it("answers browser preflights only on MCP transport routes without bypassing bearer auth", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    for (const path of ["/mcp", "/sse", "/messages"]) {
      await request(app)
        .options(path)
        .set("Host", "mail.example")
        .set("Origin", "http://localhost:3000")
        .set("Access-Control-Request-Method", path === "/sse" ? "GET" : "POST")
        .set("Access-Control-Request-Headers", "authorization,content-type,mcp-protocol-version")
        .expect(204)
        .expect("Access-Control-Allow-Origin", "*")
        .expect("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        .expect("Access-Control-Allow-Headers", /Authorization/);
    }
    await request(app)
      .post("/mcp")
      .set("Host", "mail.example")
      .set("Origin", "http://localhost:3000")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401)
      .expect("Access-Control-Allow-Origin", "*");
    await request(app)
      .options("/setup")
      .set("Host", "mail.example")
      .set("Origin", "http://localhost:3000")
      .expect((response) => {
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      });
  });

  it("serves the same two tools over Streamable HTTP and legacy SSE with a named bearer token", async () => {
    const token = "P".repeat(48);
    const liveConfig: AppConfig = {
      ...config,
      allowedHosts: ["127.0.0.1"],
      clientTokens: [{ clientId: "polaris", token }],
    };
    const app = createHttpApp(liveConfig, fakeMail, new FakeMailboxAuth());
    const listener = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const address = listener.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const transports = [
        new StreamableHTTPClientTransport(new URL("/mcp", origin), { requestInit: { headers } }),
        new SSEClientTransport(new URL("/sse", origin), { requestInit: { headers } }),
      ];
      for (const transport of transports) {
        const client = new Client({ name: "compatibility-test", version: "1.0.0" });
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual([
          "agent_mail_query",
          "agent_mail_execute",
        ]);
        await client.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("shows a same-origin completion page before returning to ChatGPT", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    const authorization = await request(app)
      .get("/authorize")
      .set("Host", "mail.example")
      .query({
        response_type: "code",
        client_id: config.oauth.clientId,
        redirect_uri: config.oauth.redirectUri,
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        scope: "mail:read mail:reply",
        resource: config.mcpServerUrl.href,
        state: "test-state",
      })
      .expect(302);
    const approvalUrl = new URL(authorization.headers.location);
    const requestId = approvalUrl.searchParams.get("request");
    expect(requestId).toBeTruthy();

    const completion = await request(app)
      .post("/approve")
      .set("Host", "mail.example")
      .type("form")
      .send({ request: requestId, owner_code: ownerCode })
      .expect(200);
    expect(completion.text).toContain("密码验证成功");
    expect(completion.text).toContain("返回客户端完成连接");
    expect(completion.text).toContain("https://chatgpt.com/connector/oauth/test-callback");
  });

  it("rejects unknown hosts", async () => {
    const app = createHttpApp(config, fakeMail, new FakeMailboxAuth());
    await request(app).get("/setup").set("Host", "attacker.example").expect(403);
    await request(app).get("/setup").set("Host", "attacker.example@mail.example").expect(403);
  });
});
