import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import { buildAgentlyEnvironment, type AgentlyCliConfig } from "./agently-cli.js";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE = 64 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export type MailboxAuthState =
  | "idle"
  | "starting"
  | "awaiting_authorization"
  | "authorized"
  | "failed";

export interface MailboxAuthSnapshot {
  state: MailboxAuthState;
  authorizationUrl?: string;
  reason?: "CLI_UNAVAILABLE" | "LOGIN_TIMEOUT" | "LOGIN_FAILED";
  updatedAt: string;
}

export interface MailboxAuthController {
  status(): Promise<MailboxAuthSnapshot>;
  start(): Promise<MailboxAuthSnapshot>;
}

export function extractAuthorizationUrl(output: string): string | undefined {
  const candidates = output.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "agent.qq.com" &&
        url.pathname === "/page/oauth" &&
        url.searchParams.get("oauth_type") === "device" &&
        url.searchParams.has("user_code")
      ) {
        return url.href;
      }
    } catch {
      // Ignore output that only happens to look like a URL.
    }
  }
  return undefined;
}

function now(): string {
  return new Date().toISOString();
}

export class AgentlyWebAuth implements MailboxAuthController {
  private snapshot: MailboxAuthSnapshot = { state: "idle", updatedAt: now() };
  private child: ChildProcess | undefined;
  private captured = "";
  private timeout: NodeJS.Timeout | undefined;

  constructor(private readonly config: AgentlyCliConfig) {}

  async status(): Promise<MailboxAuthSnapshot> {
    if (await this.hasStoredLogin()) {
      this.setSnapshot({ state: "authorized" });
    }
    return { ...this.snapshot };
  }

  async start(): Promise<MailboxAuthSnapshot> {
    if (this.child && this.child.exitCode === null) {
      return { ...this.snapshot };
    }
    if (await this.hasStoredLogin()) {
      this.setSnapshot({ state: "authorized" });
      return { ...this.snapshot };
    }

    this.captured = "";
    this.setSnapshot({ state: "starting" });
    const child = spawn(this.config.binary, ["auth", "login"], {
      env: buildAgentlyEnvironment(this.config),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;

    const capture = (chunk: Buffer | string) => {
      this.captured = `${this.captured}${chunk.toString()}`.slice(-MAX_CAPTURE);
      const authorizationUrl = extractAuthorizationUrl(this.captured);
      if (authorizationUrl) {
        this.setSnapshot({ state: "awaiting_authorization", authorizationUrl });
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", () => {
      this.clearChild();
      this.setSnapshot({ state: "failed", reason: "CLI_UNAVAILABLE" });
    });
    child.once("exit", (code, signal) => {
      void this.onExit(code, signal);
    });

    this.timeout = setTimeout(() => {
      if (this.child === child && child.exitCode === null) {
        child.kill("SIGTERM");
        this.clearChild();
        this.setSnapshot({ state: "failed", reason: "LOGIN_TIMEOUT" });
      }
    }, LOGIN_TIMEOUT_MS);
    this.timeout.unref();

    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ...this.snapshot };
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const timedOut = this.snapshot.reason === "LOGIN_TIMEOUT";
    this.clearChild();
    if (timedOut) {
      return;
    }
    if (code === 0 && !signal && await this.hasStoredLogin()) {
      this.setSnapshot({ state: "authorized" });
      return;
    }
    this.setSnapshot({ state: "failed", reason: "LOGIN_FAILED" });
  }

  private async hasStoredLogin(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(this.config.binary, ["auth", "status"], {
        env: buildAgentlyEnvironment(this.config),
        timeout: Math.min(this.config.timeoutMs, 5_000),
        maxBuffer: 128 * 1024,
        windowsHide: true,
        shell: false,
      });
      const response = JSON.parse(stdout) as {
        ok?: unknown;
        data?: { logged_in?: unknown; status?: unknown };
      };
      return response.ok === true && response.data?.logged_in === true;
    } catch {
      return false;
    }
  }

  private setSnapshot(next: Omit<MailboxAuthSnapshot, "updatedAt">): void {
    this.snapshot = { ...next, updatedAt: now() };
  }

  private clearChild(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.child = undefined;
    this.captured = "";
  }
}

