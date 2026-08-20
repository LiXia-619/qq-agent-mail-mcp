# Deployment and ChatGPT connection

## 1. Cloud service

Build the included `Dockerfile`, expose its port through HTTPS, run one replica, and mount a persistent volume at `/data/agently-cli`. The image runs as the unprivileged `node` user and pins the official Agent Mail CLI.

## 2. Secrets and environment

Run `npm run generate-secrets` on a trusted computer. Keep `OWNER_CODE` in a password manager and configure only the generated hash and signing secret through the host's secret manager.

Required production variables:

| Variable | Value |
|---|---|
| `MCP_PUBLIC_ORIGIN` | Public HTTPS origin without a path |
| `OAUTH_CLIENT_ID` | Static fallback connector identifier |
| `OAUTH_REDIRECT_URI` | Exact callback shown by ChatGPT |
| `OAUTH_OWNER_CODE_HASH` | Generated scrypt hash |
| `OAUTH_SIGNING_SECRET` | Independent generated signing secret |
| `OAUTH_CLIENTS_FILE` | Optional; defaults to `/data/agently-cli/oauth-clients.json` |
| `AGENTLY_CLI_CONFIG_DIR` | `/data/agently-cli` |
| `AGENTLY_WORKSPACE` | `default` |

## 3. Authorize the mailbox once

Open `https://YOUR_HOST/setup`, enter `OWNER_CODE`, start authorization, and complete Tencent's page. Keep the setup tab open until it reports **邮箱已连接**.

The credential, local encryption key, and OAuth client registrations share the persistent volume. A later deployment or a new ChatGPT window should not require Tencent authorization again.

## 4. Add the ChatGPT connector

Create a developer-mode app for `https://YOUR_HOST/mcp` with OAuth and select Dynamic Client Registration. The existing `mail:read mail:reply` scope pair remains compatible with v0.3 connections; `mail:reply` is the legacy name of the v0.4 connector write grant.

After connection, the tool list must contain exactly:

- `agent_mail_query`
- `agent_mail_execute`

Query action `capabilities` must return the complete server-side action catalog. New provider actions are added to that catalog without adding another MCP tool.

## 5. Verify before deployment

Run `npm ci`, `npm run build`, and `npm test`. Then verify:

- `/healthz` reports `agent-mail-gateway` v0.4.2;
- unauthenticated `/mcp` requests return 401;
- mailbox identity still works without Tencent reauthorization;
- `capabilities` returns the action catalog;
- use only owner-controlled messages and attachments for real-mail smoke tests.
