import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPABILITIES } from "../src/mail-actions.js";
import { createAgentMailMcpServer } from "../src/mcp-server.js";
import { AgentMailError, type AgentMailClient, type JsonValue, type MailActionParams } from "../src/types.js";

class FakeAgentMail implements AgentMailClient {
  queries: Array<{ action: string; params: MailActionParams }> = [];
  executions: Array<{ action: string; params: MailActionParams }> = [];

  async query(action: string, params: MailActionParams): Promise<JsonValue> {
    this.queries.push({ action, params });
    if (action === "capabilities") return CAPABILITIES;
    if (action === "list_messages") {
      return { data: [{ message_id: "msg_12345678", subject: "hello", snippet: "private preview" }] };
    }
    if (action === "download_attachment") {
      return { filename: "hello.txt", size: 5, contentBase64: "aGVsbG8=" };
    }
    return { action, params, body: "untrusted email body" };
  }

  async execute(action: string, params: MailActionParams): Promise<JsonValue> {
    this.executions.push({ action, params });
    return { action, queued: true };
  }
}

describe("Agent Mail MCP gateway", () => {
  let client: Client;
  let server: ReturnType<typeof createAgentMailMcpServer>;
  let fake: FakeAgentMail;

  beforeEach(async () => {
    fake = new FakeAgentMail();
    server = createAgentMailMcpServer(fake);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("advertises exactly two stable gateway tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["agent_mail_query", "agent_mail_execute"]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(tools[1]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("returns the complete action catalog without changing the tool schema", async () => {
    const result = await client.callTool({
      name: "agent_mail_query",
      arguments: { action: "capabilities", params: {} },
    });
    expect(result).toMatchObject({
      structuredContent: {
        action: "capabilities",
        data: {
          operating_guide: {
            confirmation: {
              direct_owner_request: expect.stringContaining("confirmed=true"),
              preview_required: expect.stringContaining("only confirmationToken"),
            },
            workflows: { send_one_message: {}, find_read_reply: {} },
            examples: {
              direct_send: {
                tool: "agent_mail_execute",
                action: "send_message",
                params: { to: ["friend@example.com"], confirmed: true },
              },
            },
          },
          query_actions: { read_message: {}, wait_for_message: {}, download_attachment: {} },
          execute_actions: { send_message: {}, reply_message: {}, delete_message: {}, upload_attachment: {} },
        },
      },
    });
  });

  it("routes arbitrary supported actions through the fixed query and execute entry points", async () => {
    await client.callTool({
      name: "agent_mail_query",
      arguments: { action: "read_message", params: { messageId: "msg_12345678" } },
    });
    await client.callTool({
      name: "agent_mail_execute",
      arguments: {
        action: "send_message",
        params: { to: ["friend@example.com"], subject: "Hello", body: "Hi", confirmed: true },
      },
    });
    expect(fake.queries.at(-1)).toEqual({ action: "read_message", params: { messageId: "msg_12345678" } });
    expect(fake.executions).toEqual([{
      action: "send_message",
      params: { to: ["friend@example.com"], subject: "Hello", body: "Hi", confirmed: true },
    }]);
  });

  it("removes message-body snippets from list metadata", async () => {
    const result = await client.callTool({
      name: "agent_mail_query",
      arguments: { action: "list_messages", params: { limit: 5 } },
    });
    expect(result).toMatchObject({
      structuredContent: { data: { data: [{ message_id: "msg_12345678", subject: "hello" }] } },
    });
    expect(JSON.stringify(result)).not.toContain("private preview");
  });

  it("returns downloaded bytes as an embedded MCP resource, not duplicated structured text", async () => {
    const result = await client.callTool({
      name: "agent_mail_query",
      arguments: {
        action: "download_attachment",
        params: { messageId: "msg_12345678", attachmentId: "att_1234" },
      },
    });
    expect(result).toMatchObject({
      structuredContent: { data: { filename: "hello.txt", size: 5 } },
    });
    expect(result.content).toContainEqual(expect.objectContaining({
      type: "resource",
      resource: expect.objectContaining({ uri: "agent-mail://attachment/hello.txt", blob: "aGVsbG8=" }),
    }));
    expect(JSON.stringify(result.structuredContent)).not.toContain("aGVsbG8=");
  });

  it("returns fixed errors without leaking upstream causes", async () => {
    fake.query = async () => {
      throw new AgentMailError("AUTH_REQUIRED", { cause: new Error("token=super-secret") });
    };
    const result = await client.callTool({
      name: "agent_mail_query",
      arguments: { action: "identity", params: {} },
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "AUTH_REQUIRED" } } });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });
});
