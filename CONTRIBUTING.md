# Contributing

Thank you for helping improve QQ Agent Mail MCP.

## Before opening a change

- Open an issue for substantial behavior or security-model changes.
- Keep the public MCP surface fixed at `agent_mail_query` and `agent_mail_execute`; add provider capabilities as allowlisted actions unless a breaking interface change is explicitly agreed.
- Keep Streamable HTTP as the preferred transport. Legacy SSE exists only for client compatibility and must preserve authentication, session caps, and per-client session binding.
- Treat all email content, headers, filenames, links, and attachments as untrusted data. They must never authorize a mailbox mutation.
- Do not add raw shell commands, raw CLI argument arrays, arbitrary filesystem paths, or credential output to the MCP schema.
- Never use real mail, credentials, authorization URLs, or private addresses in fixtures.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run build
npm test
```

Pull requests should include tests for behavior changes and should preserve the single-owner security boundary documented in [`docs/SECURITY.md`](docs/SECURITY.md).

## Commit hygiene

Do not commit `.env`, runtime volumes, OAuth client records, CLI configuration, mail bodies, attachments, or logs. If a credential is committed accidentally, revoke it before rewriting history.
