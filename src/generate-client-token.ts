import { randomBytes } from "node:crypto";

const clientId = process.argv[2]?.trim();
if (!clientId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clientId)) {
  throw new Error("Usage: npm run generate-client-token -- <client-id>");
}

const token = randomBytes(48).toString("base64url");
console.log(`${clientId}:${token}`);
console.log("Append this entry to MCP_CLIENT_TOKENS in the host secret manager, then store the token in that client only.");
