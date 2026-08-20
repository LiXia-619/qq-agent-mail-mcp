import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface PendingAuthorization {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AuthorizationCodeRecord extends PendingAuthorization {
  redirectUri: string;
}

interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string[];
  typ: "access" | "refresh";
  iat: number;
  exp: number;
  jti: string;
}

export interface SingleOwnerOAuthConfig {
  issuerUrl: URL;
  resourceUrl: URL;
  clientId: string;
  redirectUri: string;
  clientsFile: string;
  ownerCodeHash: string;
  signingSecret: string;
}

interface PersistedClients {
  version: 1;
  clients: OAuthClientInformationFull[];
}

const MAX_DYNAMIC_CLIENTS = 50;
const SUPPORTED_SCOPES = ["mail:read", "mail:reply"] as const;
const DEFAULT_SCOPE = SUPPORTED_SCOPES.join(" ");

export class PersistentClientsStore implements OAuthRegisteredClientsStore {
  private readonly staticClient: OAuthClientInformationFull;
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(
    clientId: string,
    redirectUri: string,
    private readonly clientsFile: string,
  ) {
    this.staticClient = {
      client_id: clientId,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT Agent Mail",
      scope: DEFAULT_SCOPE,
    };
    this.load();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (clientId === this.staticClient.client_id) {
      return this.staticClient;
    }
    return this.clients.get(clientId);
  }

  registerClient(
    metadata: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    this.validateRegistration(metadata);
    const client: OAuthClientInformationFull = {
      ...metadata,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1_000),
      client_secret: undefined,
      client_secret_expires_at: undefined,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: DEFAULT_SCOPE,
    };
    this.clients.set(client.client_id, client);
    this.prune();
    this.persist();
    return client;
  }

  private validateRegistration(
    metadata: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): void {
    if (metadata.token_endpoint_auth_method !== "none" || metadata.client_secret) {
      throw new Error("Only public OAuth clients are supported");
    }
    if (!metadata.redirect_uris.length || metadata.redirect_uris.some((value) => {
      try {
        const redirect = new URL(value);
        return redirect.origin !== "https://chatgpt.com" ||
          !redirect.pathname.startsWith("/connector/oauth/") ||
          Boolean(redirect.search) ||
          Boolean(redirect.hash);
      } catch {
        return true;
      }
    })) {
      throw new Error("Only exact ChatGPT connector callbacks are supported");
    }
    if (metadata.grant_types?.some((value) =>
      value !== "authorization_code" && value !== "refresh_token")) {
      throw new Error("Unsupported OAuth grant type");
    }
    if (metadata.response_types?.some((value) => value !== "code")) {
      throw new Error("Unsupported OAuth response type");
    }
    if (metadata.scope && metadata.scope.split(/\s+/).some((value) =>
      !SUPPORTED_SCOPES.includes(value as typeof SUPPORTED_SCOPES[number]))) {
      throw new Error("Unsupported OAuth scope");
    }
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.clientsFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const saved = JSON.parse(text) as PersistedClients;
    if (saved.version !== 1 || !Array.isArray(saved.clients)) {
      throw new Error("Invalid persisted OAuth client store");
    }
    for (const client of saved.clients) {
      if (!client.client_id || !Array.isArray(client.redirect_uris)) {
        throw new Error("Invalid persisted OAuth client record");
      }
      this.clients.set(client.client_id, client);
    }
    this.prune();
  }

  private prune(): void {
    const ordered = [...this.clients.values()].sort((left, right) =>
      (left.client_id_issued_at ?? 0) - (right.client_id_issued_at ?? 0));
    for (const client of ordered.slice(0, Math.max(0, ordered.length - MAX_DYNAMIC_CLIENTS))) {
      this.clients.delete(client.client_id);
    }
  }

  private persist(): void {
    const directory = dirname(this.clientsFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.clientsFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const payload: PersistedClients = { version: 1, clients: [...this.clients.values()] };
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, this.clientsFile);
    chmodSync(this.clientsFile, 0o600);
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function signToken(claims: TokenClaims, secret: string): string {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson(claims);
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token: string, secret: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Invalid token");
  }
  const expected = createHmac("sha256", secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (!safeEqual(expected, actual)) {
    throw new Error("Invalid token");
  }
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenClaims;
  const now = Math.floor(Date.now() / 1_000);
  if (!claims || claims.exp <= now || claims.iat > now + 60) {
    throw new Error("Expired token");
  }
  return claims;
}

export function hashOwnerCode(ownerCode: string, salt = randomBytes(16)): string {
  if (ownerCode.length < 20) {
    throw new Error("Owner code must be at least 20 characters");
  }
  const digest = scryptSync(ownerCode, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export function verifyOwnerCode(ownerCode: string, encodedHash: string): boolean {
  const [algorithm, saltText, digestText] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = scryptSync(ownerCode, salt, expected.length);
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class SingleOwnerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly clientStore: PersistentClientsStore;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly approved = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();

  constructor(private readonly config: SingleOwnerOAuthConfig) {
    this.clientStore = new PersistentClientsStore(
      config.clientId,
      config.redirectUri,
      config.clientsFile,
    );
    this.clientsStore = this.clientStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.prune();
    this.assertResource(params.resource);
    const requestId = randomBytes(32).toString("base64url");
    this.pending.set(requestId, {
      clientId: client.client_id,
      params,
      expiresAt: Date.now() + 5 * 60_000,
    });
    const approvalUrl = new URL("/approve", this.config.issuerUrl);
    approvalUrl.searchParams.set("request", requestId);
    res.redirect(302, approvalUrl.href);
  }

  getPending(requestId: string): PendingAuthorization | undefined {
    this.prune();
    return this.pending.get(requestId);
  }

  approve(requestId: string, ownerCode: string): string {
    this.prune();
    if (!verifyOwnerCode(ownerCode.trim(), this.config.ownerCodeHash)) {
      throw new Error("Approval failed");
    }
    const pending = this.pending.get(requestId) ?? this.approved.get(requestId);
    if (!pending) {
      throw new Error("Approval failed");
    }
    if (this.pending.delete(requestId)) {
      this.approved.set(requestId, {
        ...pending,
        expiresAt: Date.now() + 2 * 60_000,
      });
    }
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      ...pending,
      redirectUri: pending.params.redirectUri,
      expiresAt: Date.now() + 2 * 60_000,
    });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state) {
      redirect.searchParams.set("state", pending.params.state);
    }
    return redirect.href;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.prune();
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new Error("Invalid authorization code");
    }
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.prune();
    const record = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new Error("Invalid authorization code");
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new Error("Redirect URI mismatch");
    }
    this.assertResource(resource ?? record.params.resource);
    return this.issueTokens(client.client_id, record.params.scopes ?? [...SUPPORTED_SCOPES]);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const claims = this.validateToken(refreshToken, "refresh");
    if (claims.client_id !== client.client_id) {
      throw new Error("Refresh token client mismatch");
    }
    this.assertResource(resource ?? new URL(claims.aud));
    const requested = scopes ?? claims.scope;
    if (requested.some((scope) => !claims.scope.includes(scope))) {
      throw new Error("Refresh scope escalation denied");
    }
    return this.issueTokens(client.client_id, requested);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.validateToken(token, "access");
    if (!SUPPORTED_SCOPES.every((scope) => claims.scope.includes(scope))) {
      throw new Error("Required scope is missing");
    }
    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope,
      expiresAt: claims.exp,
      resource: new URL(claims.aud),
    };
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const uniqueScopes = [...new Set(scopes.length ? scopes : [...SUPPORTED_SCOPES])]
      .filter((scope) => SUPPORTED_SCOPES.includes(scope as typeof SUPPORTED_SCOPES[number]));
    if (!SUPPORTED_SCOPES.every((scope) => uniqueScopes.includes(scope))) {
      throw new Error("Both mail:read and mail:reply scopes are required");
    }
    const now = Math.floor(Date.now() / 1_000);
    const base = {
      iss: this.config.issuerUrl.href,
      aud: this.config.resourceUrl.href,
      sub: "agent-mail-owner",
      client_id: clientId,
      scope: uniqueScopes,
      iat: now,
    };
    const accessToken = signToken(
      { ...base, typ: "access", exp: now + 30 * 60, jti: randomUUID() },
      this.config.signingSecret,
    );
    const refreshToken = signToken(
      { ...base, typ: "refresh", exp: now + 7 * 24 * 60 * 60, jti: randomUUID() },
      this.config.signingSecret,
    );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: 30 * 60,
      scope: uniqueScopes.join(" "),
    };
  }

  private validateToken(token: string, expectedType: TokenClaims["typ"]): TokenClaims {
    const claims = verifyToken(token, this.config.signingSecret);
    if (
      claims.typ !== expectedType ||
      claims.iss !== this.config.issuerUrl.href ||
      claims.aud !== this.config.resourceUrl.href ||
      !this.clientStore.getClient(claims.client_id)
    ) {
      throw new Error("Invalid token claims");
    }
    return claims;
  }

  private assertResource(resource: URL | undefined): void {
    if (!resource || resource.href !== this.config.resourceUrl.href) {
      throw new Error("Invalid OAuth resource");
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
    for (const [key, value] of this.approved) {
      if (value.expiresAt <= now) {
        this.approved.delete(key);
      }
    }
    for (const [key, value] of this.codes) {
      if (value.expiresAt <= now) {
        this.codes.delete(key);
      }
    }
  }
}

