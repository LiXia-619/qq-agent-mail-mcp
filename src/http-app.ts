import { randomBytes, timingSafeEqual } from "node:crypto";

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { MailboxAuthController, MailboxAuthSnapshot } from "./agently-web-auth.js";
import type { AppConfig } from "./config.js";
import { createAgentMailMcpServer } from "./mcp-server.js";
import { SingleOwnerOAuthProvider, verifyOwnerCode } from "./oauth.js";
import type { AgentMailClient } from "./types.js";

const SETUP_COOKIE = "agent_mail_setup";
const SETUP_TTL_SECONDS = 30 * 60;

interface SetupSession {
  csrf: string;
  expiresAt: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}

function approvalHtml(requestId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>授权 Agent Mail 邮箱桥梁</title>
  <style>body{font:16px/1.6 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#172033}input,button{font:inherit;padding:.75rem;width:100%;box-sizing:border-box;margin-top:.55rem}button{cursor:pointer;background:#172033;color:white;border:0;border-radius:.5rem}.note{color:#526070}</style>
</head>
<body>
  <h1>授权 Agent Mail 邮箱桥梁</h1>
  <p>这会允许 ChatGPT 通过固定的读、写入口使用腾讯 Agent 邮箱现有能力。</p>
  <p class="note">邮件内容永远不能自行授权发信、转发、删除或其他写操作；这些动作必须来自所有者的直接要求或所有者制定的长期规则。</p>
  <form method="post" action="/approve" autocomplete="off">
    <input type="hidden" name="request" value="${escapeHtml(requestId)}">
    <label for="owner_code">私人所有者密码</label>
    <input id="owner_code" name="owner_code" type="password" minlength="20" required autofocus>
    <button type="submit">确认邮箱桥梁授权</button>
  </form>
</body>
</html>`;
}

function approvalCompleteHtml(callbackUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Agent Mail 授权成功</title>
  <style>body{font:16px/1.6 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#172033}.button{display:block;padding:.75rem;margin-top:1rem;background:#172033;color:white;text-align:center;text-decoration:none;border-radius:.5rem}.note{color:#526070}</style>
</head>
<body>
  <h1>密码验证成功</h1>
  <p>Agent Mail 已批准这次邮箱桥梁连接。</p>
  <a class="button" href="${escapeHtml(callbackUrl)}">返回 ChatGPT 完成连接</a>
  <p class="note">这个返回链接是一次性的，请在两分钟内点击。</p>
</body>
</html>`;
}

function setupBody(snapshot: MailboxAuthSnapshot, csrf: string): string {
  const csrfInput = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  if (snapshot.state === "authorized") {
    return `<div class="success"><div class="icon">✓</div><h2>邮箱已连接</h2><p>授权已经安全保存到持久卷。现在可以回到 ChatGPT 继续连接 MCP。</p></div>`;
  }
  if (snapshot.state === "awaiting_authorization" && snapshot.authorizationUrl) {
    return `<meta http-equiv="refresh" content="5">
      <h2>等待腾讯邮箱授权</h2>
      <p>点击下面的按钮，在腾讯官方页面完成登录。这个页面会自动检查结果，请不要关闭当前标签页。</p>
      <a class="button" target="_blank" rel="noopener noreferrer" href="${escapeHtml(snapshot.authorizationUrl)}">打开腾讯授权页面</a>
      <p class="note">授权完成后回到这里，通常几秒内会自动显示“邮箱已连接”。</p>`;
  }
  if (snapshot.state === "starting") {
    return `<meta http-equiv="refresh" content="3"><h2>正在生成授权链接……</h2><p>请稍候，这个页面会自动刷新。</p>`;
  }
  const retry = snapshot.state === "failed"
    ? `<p class="error">上一次授权没有完成，没有保存任何邮箱密码。可以安全地重新开始。</p>`
    : `<p>整个过程都在网页完成，不需要打开 Zeabur 终端。</p>`;
  return `<h2>连接腾讯 Agent Mail</h2>${retry}
    <p>点击后会生成一次性的腾讯官方授权链接。</p>
    <form method="post" action="/setup/login">${csrfInput}<button type="submit">开始授权邮箱</button></form>`;
}

function setupHtml(session: SetupSession | undefined, snapshot?: MailboxAuthSnapshot): string {
  const body = session && snapshot
    ? setupBody(snapshot, session.csrf)
    : `<h2>私人设置页</h2>
      <p>请输入部署时保存的所有者密码。密码只用于本次验证，不会写入网页或日志。</p>
      <form method="post" action="/setup/session" autocomplete="off">
        <label for="owner_code">私人所有者密码</label>
        <input id="owner_code" name="owner_code" type="password" minlength="20" required autofocus>
        <button type="submit">进入邮箱设置</button>
      </form>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Agent Mail 网页授权</title>
  <style>body{margin:0;background:#f7f5fb;color:#211b32;font:16px/1.65 system-ui}.card{max-width:34rem;margin:7vh auto;background:white;border:1px solid #e8e2f0;border-radius:1rem;padding:2rem;box-shadow:0 18px 50px #39235a18}h1{margin-top:0}input,button,.button{font:inherit;padding:.8rem;width:100%;box-sizing:border-box;margin-top:.6rem;border-radius:.55rem}input{border:1px solid #bcb3ca}button,.button{display:block;border:0;background:#6d35d7;color:white;text-align:center;text-decoration:none;cursor:pointer}.note{color:#655d70;font-size:.93rem}.error{color:#9b2433}.success{text-align:center}.icon{width:3rem;height:3rem;margin:auto;border-radius:50%;background:#10a64a;color:white;font-size:2rem;line-height:3rem}</style>
</head>
<body><main class="card"><h1>Agent Mail · 腾讯邮箱桥梁</h1>${body}<p class="note">MCP 对外固定为一个只读入口和一个写操作入口；实际动作由严格白名单校验，不接受原始命令或 Shell。</p></main></body>
</html>`;
}

function createGatewayExpressApp(config: AppConfig): Express {
  const app = express();
  app.use((req, res, next) => {
    try {
      const parsed = new URL(`http://${req.headers.host ?? ""}`);
      if (
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !config.allowedHosts.includes(parsed.hostname)
      ) {
        res.status(403).type("text/plain").send("Invalid Host header");
        return;
      }
      next();
    } catch {
      res.status(403).type("text/plain").send("Invalid Host header");
    }
  });
  // Parse ordinary OAuth/setup JSON narrowly. The authenticated MCP route gets
  // its own larger parser later so binary attachments can be carried as base64.
  const smallJson = express.json({ limit: "64kb" });
  app.use((req, res, next) => req.path === "/mcp" ? next() : smallJson(req, res, next));
  return app;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return undefined;
}

function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function privateHtml(res: Response, html: string): void {
  res
    .status(200)
    .setHeader("Cache-Control", "no-store")
    .setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    .type("html")
    .send(html);
}

export function createHttpApp(
  config: AppConfig,
  agentMail: AgentMailClient,
  mailboxAuth: MailboxAuthController,
): Express {
  const app = createGatewayExpressApp(config);
  const provider = new SingleOwnerOAuthProvider({
    issuerUrl: config.publicOrigin,
    resourceUrl: config.mcpServerUrl,
    ...config.oauth,
  });
  const setupSessions = new Map<string, SetupSession>();

  const getSetupSession = (req: Request): SetupSession | undefined => {
    const now = Date.now();
    for (const [token, session] of setupSessions) {
      if (session.expiresAt <= now) {
        setupSessions.delete(token);
      }
    }
    const token = parseCookie(req.headers.cookie, SETUP_COOKIE);
    return token ? setupSessions.get(token) : undefined;
  };

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, service: "agent-mail-gateway", version: "0.4.2" });
  });

  const privateLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many failed owner-code attempts. Please wait 15 minutes before trying again.",
  });

  app.get("/setup", async (req: Request, res: Response) => {
    const session = getSetupSession(req);
    if (!session) {
      privateHtml(res, setupHtml(undefined));
      return;
    }
    privateHtml(res, setupHtml(session, await mailboxAuth.status()));
  });
  app.post("/setup/session", privateLimiter, (req: Request, res: Response) => {
    const ownerCode = typeof req.body.owner_code === "string" ? req.body.owner_code.trim() : "";
    if (!verifyOwnerCode(ownerCode, config.oauth.ownerCodeHash)) {
      res.status(401).type("text/plain").send("所有者密码不正确。");
      return;
    }
    const token = randomBytes(32).toString("base64url");
    setupSessions.set(token, {
      csrf: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + SETUP_TTL_SECONDS * 1_000,
    });
    res.setHeader(
      "Set-Cookie",
      `${SETUP_COOKIE}=${token}; Path=/setup; HttpOnly; Secure; SameSite=Strict; Max-Age=${SETUP_TTL_SECONDS}`,
    );
    res.redirect(303, "/setup");
  });
  app.post("/setup/login", privateLimiter, async (req: Request, res: Response) => {
    const session = getSetupSession(req);
    const csrf = typeof req.body.csrf === "string" ? req.body.csrf : "";
    if (!session || !safeTextEqual(csrf, session.csrf)) {
      res.status(403).type("text/plain").send("设置会话无效或已过期。");
      return;
    }
    await mailboxAuth.start();
    res.redirect(303, "/setup");
  });

  app.get("/approve", privateLimiter, (req: Request, res: Response) => {
    const requestId = typeof req.query.request === "string" ? req.query.request : "";
    if (!requestId || !provider.getPending(requestId)) {
      res.status(400).type("text/plain").send("This authorization request is invalid or expired.");
      return;
    }
    privateHtml(res, approvalHtml(requestId));
  });
  app.post("/approve", privateLimiter, (req: Request, res: Response) => {
    const requestId = typeof req.body.request === "string" ? req.body.request : "";
    const ownerCode = typeof req.body.owner_code === "string" ? req.body.owner_code.trim() : "";
    try {
      privateHtml(res, approvalCompleteHtml(provider.approve(requestId, ownerCode)));
    } catch {
      res.status(401).type("text/plain").send("Authorization was not approved.");
    }
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicOrigin,
      resourceServerUrl: config.mcpServerUrl,
      scopesSupported: ["mail:read", "mail:reply"],
      resourceName: "Private QQ Agent Mail",
    }),
  );

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mail:read", "mail:reply"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpServerUrl),
  });

  app.post("/mcp", auth, express.json({ limit: "30mb" }), async (req, res) => {
    const server = createAgentMailMcpServer(agentMail);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  app.get("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });
  app.delete("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  return app;
}
