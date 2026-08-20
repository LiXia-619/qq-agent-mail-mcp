import { randomBytes } from "node:crypto";

import { hashOwnerCode } from "./oauth.js";

const ownerCode = randomBytes(24).toString("base64url");
const signingSecret = randomBytes(48).toString("base64url");

console.log(`OWNER_CODE=${ownerCode}`);
console.log(`OAUTH_OWNER_CODE_HASH=${hashOwnerCode(ownerCode)}`);
console.log(`OAUTH_SIGNING_SECRET=${signingSecret}`);
console.log("Store OWNER_CODE in a password manager. Put only the two OAUTH_* values in cloud secrets.");

