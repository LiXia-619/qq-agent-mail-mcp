#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.AGENTLY_WORKSPACE === "auth-error") {
  console.log(JSON.stringify({
    ok: false,
    error: { type: "auth", message: "authorization required" },
  }));
  process.exit(3);
}
if (args.includes("+watch")) {
  console.log(JSON.stringify({ message_id: "msg_watch1234", subject: "new mail" }));
  process.exit(0);
}
if (args.includes("+download")) {
  writeFileSync("downloaded.txt", "downloaded attachment", { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    data: { filename: "downloaded.txt", saved_to: `${process.cwd()}/downloaded.txt`, size: 21 },
  }));
  process.exit(0);
}
if (
  args.includes("+send") &&
  args.includes("Needs confirmation") &&
  !args.includes("--confirmed") &&
  !args.includes("--confirmation-token")
) {
  console.log(JSON.stringify({
    ok: true,
    data: {
      requires_confirmation: true,
      confirmation_token: "confirm_cached1234",
      summary: { subject: "Needs confirmation", to: ["friend@example.com"] },
    },
  }));
  process.exit(0);
}
const attachedFiles = [];
for (let index = 0; index < args.length; index += 1) {
  if ((args[index] === "--attachment" || args[index] === "--file") && args[index + 1]) {
    attachedFiles.push({ path: args[index + 1], content: readFileSync(args[index + 1], "utf8") });
  }
}
console.log(JSON.stringify({
  ok: true,
  data: {
    args,
    workspace: process.env.AGENTLY_WORKSPACE ?? null,
    config_dir: process.env.AGENTLY_CLI_CONFIG_DIR ?? null,
    agent_token_present: Boolean(process.env.AGENTLY_ACCESS_TOKEN),
    unrelated_present: Boolean(process.env.UNRELATED_ENV_SHOULD_NOT_LEAK),
    attached_files: attachedFiles,
  },
}));
