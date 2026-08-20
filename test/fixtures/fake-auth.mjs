#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const configDir = process.env.AGENTLY_CLI_CONFIG_DIR;
if (!configDir) process.exit(2);
const marker = join(configDir, "authorized");

if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({
    ok: true,
    data: { logged_in: existsSync(marker), status: existsSync(marker) ? "logged_in" : "not_logged_in" },
  }));
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login") {
  console.log("请点击以下链接登录并授权邮箱：");
  console.log("https://agent.qq.com/page/oauth?oauth_type=device&user_code=uc_test-only");
  setTimeout(() => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(marker, "yes", { mode: 0o600 });
    process.exit(0);
  }, 350);
  setInterval(() => undefined, 1_000);
}

