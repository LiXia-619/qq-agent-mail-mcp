import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { buildAgentlyEnvironment, SubprocessAgentlyCli } from "../src/agently-cli.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-agently.mjs", import.meta.url));

describe("SubprocessAgentlyCli gateway", () => {
  beforeAll(() => {
    chmodSync(fixture, 0o755);
    process.env.UNRELATED_ENV_SHOULD_NOT_LEAK = "never-forward-this";
  });

  const client = new SubprocessAgentlyCli({
    binary: fixture,
    configDir: "/tmp/agent-mail-test-config",
    workspace: "test-owner",
    accessToken: "agent-mail-token",
    timeoutMs: 5_000,
  });

  it("keeps CLI credentials and keychain state on the persistent volume", () => {
    expect(buildAgentlyEnvironment({
      binary: fixture,
      configDir: "/data/agently-cli",
      workspace: "default",
      timeoutMs: 5_000,
    })).toMatchObject({
      HOME: "/data/agently-cli",
      XDG_CONFIG_HOME: "/data/agently-cli/.config",
      XDG_DATA_HOME: "/data/agently-cli/.local/share",
      XDG_CACHE_HOME: "/data/agently-cli/.cache",
      AGENTLY_CLI_CONFIG_DIR: "/data/agently-cli",
      AGENTLY_WORKSPACE: "default",
    });
  });

  it("maps identity, list, read, and search to fixed official CLI arguments", async () => {
    await expect(client.query("identity", {})).resolves.toMatchObject({
      args: ["+me"], workspace: "test-owner", agent_token_present: true, unrelated_present: false,
    });
    await expect(client.query("list_messages", {
      limit: 7,
      folder: "sent",
      unreadOnly: true,
      hasAttachments: true,
    })).resolves.toMatchObject({
      args: ["message", "+list", "--limit", "7", "--dir", "sent", "--is-unread", "--has-attachments"],
    });
    await expect(client.query("read_message", { messageId: "msg_12345678" })).resolves.toMatchObject({
      args: ["message", "+read", "--id", "msg_12345678"],
    });
    await expect(client.query("search_messages", {
      query: "hello",
      searchIn: "subject",
      from: "friend@example.com",
      limit: 3,
    })).resolves.toMatchObject({
      args: [
        "message", "+search", "--limit", "3", "--q", "hello",
        "--search-in", "SEARCH_IN_SUBJECT", "--from", "friend@example.com",
      ],
    });
  });

  it("sends, replies, and forwards through the same execute dispatcher", async () => {
    await expect(client.execute("send_message", {
      to: ["one@example.com", "two@example.com"],
      cc: ["copy@example.com"],
      subject: "Hello",
      body: "A new letter",
      bodyFormat: "markdown",
      confirmed: true,
    })).resolves.toMatchObject({
      args: [
        "message", "+send", "--to", "one@example.com", "--to", "two@example.com",
        "--cc", "copy@example.com", "--subject", "Hello", "--body", "A new letter",
        "--body-format", "markdown", "--confirmed",
      ],
    });
    await expect(client.execute("reply_message", {
      messageId: "msg_12345678",
      body: "Thank you.\nI received it.",
      replyAll: true,
      confirmationToken: "confirm_12345678",
    })).resolves.toMatchObject({
      args: [
        "message", "+reply", "--id", "msg_12345678", "--body", "Thank you.\nI received it.",
        "--body-format", "plain", "--reply-all", "--confirmation-token", "confirm_12345678",
      ],
    });
    await expect(client.execute("forward_message", {
      messageId: "msg_12345678",
      to: ["friend@example.com"],
      includeOriginalAttachments: true,
      confirmed: true,
    })).resolves.toMatchObject({
      args: [
        "message", "+forward", "--id", "msg_12345678", "--to", "friend@example.com",
        "--include-attachments", "--confirmed",
      ],
    });
  });

  it("replays the exact cached preview when confirmation supplies only its token", async () => {
    await expect(client.execute("send_message", {
      to: ["friend@example.com"],
      subject: "Needs confirmation",
      body: "Exact original body",
      bodyFormat: "plain",
    })).resolves.toMatchObject({
      requires_confirmation: true,
      confirmation_token: "confirm_cached1234",
    });

    await expect(client.execute("send_message", {
      confirmationToken: "confirm_cached1234",
    })).resolves.toMatchObject({
      args: [
        "message", "+send", "--to", "friend@example.com",
        "--subject", "Needs confirmation", "--body", "Exact original body",
        "--body-format", "plain", "--confirmation-token", "confirm_cached1234",
      ],
    });
  });

  it("uses provider confirmation tokens for trash and irreversible delete", async () => {
    await expect(client.execute("trash_message", {
      messageId: "msg_12345678",
      confirmationToken: "confirm_12345678",
    })).resolves.toMatchObject({
      args: ["message", "+trash", "--id", "msg_12345678", "--confirmation-token", "confirm_12345678"],
    });
    await expect(client.execute("delete_message", {
      allTrash: true,
      confirmationToken: "confirm_abcdefgh",
    })).resolves.toMatchObject({
      args: ["message", "+delete", "--all", "--confirmation-token", "confirm_abcdefgh"],
    });
  });

  it("stages attachment bytes in an isolated temporary directory", async () => {
    await expect(client.execute("send_message", {
      to: ["friend@example.com"],
      subject: "Attachment",
      body: "See file",
      attachments: [{ filename: "note.txt", contentBase64: "aGVsbG8=" }],
      confirmed: true,
    })).resolves.toMatchObject({
      args: expect.arrayContaining(["--attachment", "./note.txt"]),
      attached_files: [{ path: "./note.txt", content: "hello" }],
    });
    await expect(client.execute("upload_attachment", {
      filename: "upload.txt",
      contentBase64: "dXBsb2FkZWQ=",
    })).resolves.toMatchObject({
      args: ["attachment", "+upload", "--file", "./upload.txt"],
      attached_files: [{ path: "./upload.txt", content: "uploaded" }],
    });
  });

  it("returns a bounded watch event and materializes a downloaded attachment", async () => {
    await expect(client.query("wait_for_message", { waitSeconds: 2, format: "event" })).resolves.toEqual({
      events: [{ message_id: "msg_watch1234", subject: "new mail" }],
    });
    await expect(client.query("download_attachment", {
      messageId: "msg_12345678",
      attachmentId: "att_1234",
    })).resolves.toMatchObject({
      filename: "downloaded.txt",
      size: 21,
      contentBase64: Buffer.from("downloaded attachment").toString("base64"),
    });
  });

  it("rejects unknown actions, injection-shaped values, and invalid confirmation combinations", async () => {
    await expect(client.query("raw_command", {})).rejects.toThrow("Unknown query action");
    await expect(client.query("read_message", { messageId: "msg_ok; rm -rf /tmp/nope" }))
      .rejects.toThrow("Invalid parameter");
    await expect(client.execute("send_message", {
      to: ["not-an-address"], subject: "Hi", body: "hello", confirmed: true,
    })).rejects.toThrow("Invalid email address");
    await expect(client.execute("reply_message", {
      messageId: "msg_12345678",
      body: "hello",
      confirmed: true,
      confirmationToken: "confirm_12345678",
    })).rejects.toThrow("mutually exclusive");
    await expect(client.execute("auth_logout", {})).rejects.toThrow("confirmed=true");
    await expect(client.query("wait_for_message", { waitSeconds: 46 })).rejects.toThrow("Invalid parameter");
    await expect(client.execute("reply_message", {
      messageId: "msg_12345678", body: "hello\0world", confirmed: true,
    })).rejects.toThrow("Invalid parameter");
  });

  it("maps the official nonzero auth envelope without leaking its message", async () => {
    const unauthenticated = new SubprocessAgentlyCli({
      binary: fixture,
      configDir: "/tmp/agent-mail-test-config",
      workspace: "auth-error",
      timeoutMs: 5_000,
    });
    await expect(unauthenticated.query("identity", {})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
