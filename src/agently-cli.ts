import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildExecuteCommand,
  buildQueryCommand,
  CAPABILITIES,
  type AttachmentInput,
  type PreparedCommand,
} from "./mail-actions.js";
import { parseCliResponse, sanitizeJson } from "./sanitize.js";
import { AgentMailError, type AgentMailClient, type JsonValue, type MailActionParams } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_CONFIRMATIONS = 100;
const MAX_PENDING_CONFIRMATION_BYTES = 25 * 1024 * 1024;

interface PendingConfirmation {
  action: string;
  params: MailActionParams;
  expiresAt: number;
  bytes: number;
}

export interface AgentlyCliConfig {
  binary: string;
  configDir: string;
  workspace: string;
  accessToken?: string;
  timeoutMs: number;
}

export function buildAgentlyEnvironment(config: AgentlyCliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "TMP", "TEMP", "TMPDIR", "SSL_CERT_DIR", "SSL_CERT_FILE",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.HOME = config.configDir;
  env.XDG_CONFIG_HOME = join(config.configDir, ".config");
  env.XDG_DATA_HOME = join(config.configDir, ".local", "share");
  env.XDG_CACHE_HOME = join(config.configDir, ".cache");
  env.AGENTLY_CLI_CONFIG_DIR = config.configDir;
  env.AGENTLY_WORKSPACE = config.workspace;
  env.AGENTLY_CLI_NO_UPDATE_NOTIFIER = "1";
  if (config.accessToken) env.AGENTLY_ACCESS_TOKEN = config.accessToken;
  return env;
}

function objectValue(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mapProcessError(cause: unknown): AgentMailError {
  if (cause instanceof AgentMailError) return cause;
  const error = cause as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  if (error.killed || error.signal === "SIGTERM") return new AgentMailError("CLI_TIMEOUT", { cause });
  if (error.code === "ENOENT") return new AgentMailError("CLI_UNAVAILABLE", { cause });
  return new AgentMailError("UPSTREAM_FAILURE", { cause });
}

export class SubprocessAgentlyCli implements AgentMailClient {
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private pendingConfirmationBytes = 0;

  constructor(private readonly config: AgentlyCliConfig) {}

  async query(action: string, params: MailActionParams): Promise<JsonValue> {
    const command = buildQueryCommand(action, params);
    if (!command) return CAPABILITIES;
    if (action === "wait_for_message") {
      const waitSeconds = typeof params.waitSeconds === "number" ? params.waitSeconds : 20;
      return this.waitForMessage(command.args, waitSeconds);
    }
    if (action === "download_attachment") return this.downloadAttachment(command);
    return this.run(command.args);
  }

  async execute(action: string, params: MailActionParams): Promise<JsonValue> {
    const effectiveParams = this.restorePendingConfirmation(action, params);
    const command = buildExecuteCommand(action, effectiveParams);
    const confirmationToken = typeof effectiveParams.confirmationToken === "string"
      ? effectiveParams.confirmationToken
      : undefined;
    // A confirmation token is one-shot from the gateway's perspective. Remove it
    // before the upstream call so an ambiguous transport failure cannot lead to
    // an accidental duplicate send on a blind retry.
    if (confirmationToken) this.dropPendingConfirmation(confirmationToken);
    let result: JsonValue;
    if (action === "upload_attachment") return this.uploadAttachment(command);
    if (command.attachments?.length) {
      result = await this.withAttachmentFiles(command.attachments, async (directory, paths) =>
        this.run([...command.args, ...paths.flatMap((path) => ["--attachment", path])], directory));
    } else {
      result = await this.run(command.args);
    }
    this.rememberPendingConfirmation(action, effectiveParams, result);
    return result;
  }

  private restorePendingConfirmation(action: string, params: MailActionParams): MailActionParams {
    this.prunePendingConfirmations();
    const token = params.confirmationToken;
    if (typeof token !== "string") return params;
    const pending = this.pendingConfirmations.get(token);
    if (!pending || pending.action !== action) return params;
    return { ...structuredClone(pending.params), confirmationToken: token };
  }

  private rememberPendingConfirmation(action: string, params: MailActionParams, result: JsonValue): void {
    const response = objectValue(result);
    const token = response.confirmation_token;
    if (typeof token !== "string" || !token || token.length > 4_096) return;
    const original = structuredClone(params);
    delete original.confirmed;
    delete original.confirmationToken;
    const bytes = Buffer.byteLength(JSON.stringify(original), "utf8");
    if (bytes > MAX_PENDING_CONFIRMATION_BYTES) return;
    this.prunePendingConfirmations();
    while (
      this.pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS ||
      this.pendingConfirmationBytes + bytes > MAX_PENDING_CONFIRMATION_BYTES
    ) {
      const oldest = this.pendingConfirmations.keys().next().value;
      if (typeof oldest !== "string") break;
      this.dropPendingConfirmation(oldest);
    }
    this.pendingConfirmations.set(token, {
      action,
      params: original,
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
      bytes,
    });
    this.pendingConfirmationBytes += bytes;
  }

  private prunePendingConfirmations(): void {
    const now = Date.now();
    for (const [token, pending] of this.pendingConfirmations) {
      if (pending.expiresAt <= now) this.dropPendingConfirmation(token);
    }
  }

  private dropPendingConfirmation(token: string): void {
    const pending = this.pendingConfirmations.get(token);
    if (!pending) return;
    this.pendingConfirmations.delete(token);
    this.pendingConfirmationBytes -= pending.bytes;
  }

  private async run(args: readonly string[], cwd?: string): Promise<JsonValue> {
    try {
      const { stdout } = await execFileAsync(this.config.binary, [...args], {
        cwd,
        env: buildAgentlyEnvironment(this.config),
        timeout: this.config.timeoutMs,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        shell: false,
      });
      return parseCliResponse(stdout);
    } catch (cause) {
      if (cause instanceof AgentMailError) throw cause;
      const error = cause as NodeJS.ErrnoException & { stdout?: string | Buffer };
      const stdout = Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf8") : error.stdout;
      if (stdout?.trim()) return parseCliResponse(stdout);
      throw mapProcessError(cause);
    }
  }

  private async waitForMessage(args: readonly string[], waitSeconds: number): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.binary, [...args], {
        env: buildAgentlyEnvironment(this.config),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      });
      let stdout = "";
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (result: JsonValue) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGTERM");
        resolve(result);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGTERM");
        reject(mapProcessError(error));
      };
      const consume = () => {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) {
          consume();
          return;
        }
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid watch event");
          finish({ events: [sanitizeJson(parsed)] });
        } catch (cause) {
          fail(new AgentMailError("INVALID_RESPONSE", { cause }));
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_OUTPUT) {
          fail(new AgentMailError("INVALID_RESPONSE"));
          return;
        }
        consume();
      });
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (settled) return;
        if (stdout.trim()) {
          stdout += "\n";
          consume();
          if (settled) return;
        }
        if (code === 0 && !signal) finish({ events: [] });
        else fail(new AgentMailError("UPSTREAM_FAILURE"));
      });
      timer = setTimeout(() => finish({ events: [] }), waitSeconds * 1_000);
      timer.unref();
    });
  }

  private async withAttachmentFiles<T>(
    attachments: readonly AttachmentInput[],
    callback: (directory: string, relativePaths: string[]) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-upload-"));
    try {
      const relativePaths: string[] = [];
      for (const attachment of attachments) {
        const relativePath = `./${attachment.filename}`;
        await writeFile(join(directory, attachment.filename), Buffer.from(attachment.contentBase64, "base64"), { mode: 0o600 });
        relativePaths.push(relativePath);
      }
      return await callback(directory, relativePaths);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async uploadAttachment(command: PreparedCommand): Promise<JsonValue> {
    const attachment = command.attachments?.[0];
    if (!attachment) throw new TypeError("Missing attachment");
    return this.withAttachmentFiles([attachment], (directory) => this.run(command.args, directory));
  }

  private async downloadAttachment(command: PreparedCommand): Promise<JsonValue> {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-download-"));
    try {
      const response = objectValue(await this.run(command.args, directory));
      const entries = await readdir(directory, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile());
      if (files.length !== 1) throw new AgentMailError("INVALID_RESPONSE");
      const file = await readFile(join(directory, files[0]!.name));
      if (file.length > MAX_DOWNLOAD_BYTES) throw new AgentMailError("INVALID_RESPONSE");
      const { saved_to: _savedTo, ...safeResponse } = response;
      return {
        ...safeResponse,
        filename: files[0]!.name,
        size: file.length,
        contentBase64: file.toString("base64"),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
