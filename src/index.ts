import { SubprocessAgentlyCli } from "./agently-cli.js";
import { AgentlyWebAuth } from "./agently-web-auth.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http-app.js";

const config = loadConfig();
const agentMail = new SubprocessAgentlyCli(config.agently);
const mailboxAuth = new AgentlyWebAuth(config.agently);
const app = createHttpApp(config, agentMail, mailboxAuth);

const listener = app.listen(config.port, config.bindHost, () => {
  console.log(JSON.stringify({
    event: "server_started",
    service: "agent-mail-gateway",
    version: "0.5.1",
    port: config.port,
  }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ event: "server_stopping", signal }));
  listener.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
