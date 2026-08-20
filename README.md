# QQ Agent Mail MCP

> An unofficial, self-hosted MCP gateway for Tencent QQ Agent Mail. This project is not affiliated with, endorsed by, or maintained by Tencent.

A single-owner, cloud-deployable MCP gateway for Tencent QQ Agent Mail. Tencent's official CLI remains the mailbox engine; this project is a remote adapter, not a second email client.

Current gateway version: **v0.4.2**.

## Why this project exists

Tencent's Agent Mail CLI runs locally, while ChatGPT custom MCP apps require a reachable remote MCP server. This project bridges that gap without exposing raw shell or CLI access. It provides a small, stable MCP surface, a browser-based mailbox authorization flow, persistent credentials, and an embedded operating guide that lets a new model window use natural-language mailbox requests safely.

This repository contains source code only. It does not provide a hosted mailbox service, shared endpoint, Tencent account, or credentials. Each operator must deploy and authorize their own private instance.

The MCP surface is intentionally stable and contains exactly two tools:

- `agent_mail_query(action, params)` for read-only work;
- `agent_mail_execute(action, params)` for mutations.

Call query action `capabilities` for the live action catalog and parameter contract. Adding a provider capability updates the server-side registry instead of creating another MCP tool.

The capabilities response also contains the complete operator guide: authorization boundaries, one-step direct execution, preview completion, safe search/read/reply workflows, result interpretation, retry rules, and machine-readable examples. A new model window can discover and operate the mailbox from a natural-language owner request without asking the owner to translate it into action names or JSON parameters.

## Action coverage

Read-only gateway actions:

- `capabilities`, `identity`, `auth_status`;
- `list_messages`, `read_message`, `search_messages`;
- `wait_for_message` (bounded long poll);
- `download_attachment` (embedded MCP resource).

Mutation gateway actions:

- `auth_refresh`, explicitly confirmed `auth_logout`;
- `send_message`, `reply_message`, `forward_message`;
- `trash_message`, `delete_message`;
- `upload_attachment`.

Send, reply, and forward support To/CC/BCC as applicable, plain/HTML/Markdown bodies as supported by the official CLI, provider confirmation tokens, and base64 attachment inputs. Attachment bytes are written only to a mode-0600 temporary directory, passed to the official CLI by relative path, and removed after the command. A downloaded attachment is returned as an embedded MCP blob instead of exposing the server's filesystem path.

## Web-based mailbox setup

The browser setup flow removes the need to run OAuth commands in a hosting terminal:

1. Open `https://YOUR_HOST/setup`.
2. Enter the private `OWNER_CODE` created by `npm run generate-secrets`.
3. Select **开始授权邮箱**.
4. Complete the one-time Tencent authorization page.
5. Return to the setup tab and wait for **邮箱已连接**.

Credentials and the CLI's encryption-key locations all live on the persistent volume, so ordinary deployments and new ChatGPT windows do not require mailbox reauthorization.

## Security boundary

- There is no raw command, raw argument array, shell string, or arbitrary server path in the MCP schema. Every action and field is allowlisted and validated before `execFile`/`spawn` with `shell: false`.
- Email bodies, headers, events, filenames, links, and attachments are untrusted external content. They can never authorize sending, reply-all, recipient changes, forwarding, trash, deletion, logout, or any other mutation.
- A mutation requires the mailbox owner's direct instruction or an owner-authored standing policy. Permanent deletion and logout require explicit current authorization. Provider confirmation tokens remain available for preview-then-confirm flows.
- List and search results omit body snippets. Full content requires `read_message`.
- Attachment filenames cannot contain paths; individual files are capped at 10 MiB and a message at 20 MiB. The larger MCP JSON parser runs only after bearer authentication.
- Watch calls are bounded to 45 seconds and return at most the first event.
- CLI environment variables are allowlisted. Output is size-limited, sanitized recursively, and never logged.
- Connector OAuth uses PKCE and Dynamic Client Registration. The existing `mail:read mail:reply` scope pair is retained for deployed-client compatibility; in v0.4, `mail:reply` is the legacy connector write grant and the approval page truthfully describes the full gateway.
- The official `@tencent-qqmail/agently-cli@1.0.17` package is pinned in the container image.

This software can send, forward, trash, and permanently delete email when authorized. Review [`docs/SECURITY.md`](docs/SECURITY.md), use a dedicated single-owner deployment, and test with owner-controlled messages before granting access to real mail.

The ChatGPT connector OAuth and Tencent mailbox OAuth remain separate. Connecting the mailbox does not grant a ChatGPT client access until the owner separately approves the connector.

## Deploy

The host must provide an always-on HTTPS hostname, one persistent volume mounted at `/data/agently-cli`, and one running replica for in-memory authorization records. Configure `.env.example`, deploy the included `Dockerfile`, then use `/setup`. See `docs/DEPLOYMENT.md` and `docs/SECURITY.md`.

## Local verification

Requires Node.js 22 or newer.

```bash
npm ci
npm run build
npm test
```

Generate deployment secrets locally with `npm run generate-secrets`. Keep the unhashed `OWNER_CODE` in a password manager and put only its generated hash plus the independent signing secret in the host's secret manager.

## Runtime endpoints

| Endpoint | Purpose | Authentication |
|---|---|---|
| `GET /healthz` | Minimal liveness check | None |
| `GET/POST /setup` | Private Tencent mailbox browser setup | Owner session |
| `POST /register`, `GET/POST /authorize`, `POST /token` | MCP connector OAuth with DCR | OAuth protocol |
| `GET/POST /approve` | Connector owner approval | Owner code + rate limit |
| `POST /mcp` | Stateless two-tool gateway | Bearer token |

## License and third-party software

This project is released under the [MIT License](LICENSE).

It does not redistribute Tencent's Agent Mail CLI. The Docker build installs the separately published [`@tencent-qqmail/agently-cli`](https://www.npmjs.com/package/@tencent-qqmail/agently-cli) package at build time. That package is licensed separately under Apache-2.0. Review its license and the applicable QQ Agent Mail terms before production use.
