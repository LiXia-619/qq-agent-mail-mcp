# Security model — stable gateway v0.5

This is an unofficial self-hosted project, not a Tencent-operated service. Each operator is the security administrator for their own deployment.

## Guarantees

- The public MCP schema is fixed at two tools. No raw CLI command, argument array, shell text, or arbitrary filesystem path is accepted.
- Every action has a server-side allowlist and per-field validation. Commands use `execFile` or `spawn` with `shell: false` and an environment allowlist.
- Email content is untrusted data and never authorization. Execute actions require the owner's direct instruction or an owner-authored standing policy.
- List/search previews are stripped. Full content requires an explicit read action.
- Send/reply/forward preserve provider confirmation flows and also support `confirmed=true` only for already authorized actions.
- Trash and permanent delete use provider confirmation tokens. Permanent deletion and logout require explicit current authorization.
- Attachments are path-free base64 inputs. Safe filenames, count, per-file size, and total size are validated; temporary files use mode 0600 and are removed after use.
- Downloaded files are read only from a fresh temporary directory, capped at 10 MiB, returned as embedded MCP resources, and removed immediately.
- Watch is a bounded single-event long poll, not an unbounded child process.
- Mailbox credentials and CLI keychain state remain on the persistent volume and are never returned by MCP.
- CLI output is bounded, recursively sanitized, and never logged.

## Known limits

- Setup sessions, connector approval requests, and authorization codes live in process memory. Run one replica; restart cancels only in-progress authorization.
- Connector tokens are signed and stateless. Rotate `OAUTH_SIGNING_SECRET` to revoke them.
- Named non-OAuth client tokens are full mailbox gateway credentials. Use one random token per client, store them only in the host secret manager and that client, and remove one entry plus redeploy to revoke that client.
- Legacy SSE keeps up to 20 authenticated sessions in process memory. Each message POST is rebound to the identity that opened its SSE stream; restarts close all sessions.
- MCP transport routes allow cross-origin browser requests for desktop-webview compatibility, but never allow cookie credentials and still require a valid bearer token on every non-preflight request. Setup and OAuth routes are not covered by this CORS policy.
- The owner code protects setup and connector approval. Keep it high entropy and private.
- Base64 makes attachment requests larger in transit. The 30 MiB MCP parser is installed only after bearer authentication.
- Hosting, volume, DNS/TLS, and Tencent's pinned official CLI are trusted infrastructure because they can access private mail.
- Real-mail interoperability must be verified with owner-controlled messages after a CLI upgrade.

## Incident response

1. Rotate `OAUTH_SIGNING_SECRET` and restart to revoke connector tokens.
2. Revoke or reauthorize Agent Mail through Tencent's official controls.
3. Rotate the owner code/hash pair.
4. Remove or replace affected `MCP_CLIENT_TOKENS` entries.
5. Rebuild from audited source and keep logs free of bodies, attachments, device URLs, credentials, and authorization headers.

## Responsible disclosure

Do not disclose vulnerabilities or real mailbox data in public issues. Follow the repository-level [`SECURITY.md`](../SECURITY.md) and use GitHub's private vulnerability reporting or a private Security Advisory when available.
