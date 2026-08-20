import { describe, expect, it } from "vitest";

import { MultiClientTokenVerifier } from "../src/client-auth.js";

const resource = new URL("https://mail.example/mcp");

describe("multi-client bearer authentication", () => {
  it("accepts OAuth tokens without changing their claims", async () => {
    const oauth = {
      async verifyAccessToken(token: string) {
        if (token !== "oauth-token") throw new Error("invalid");
        return { token, clientId: "oauth-client", scopes: ["mail:read", "mail:reply"], resource };
      },
    };
    const verifier = new MultiClientTokenVerifier(oauth, [], resource);
    await expect(verifier.verifyAccessToken("oauth-token")).resolves.toMatchObject({
      clientId: "oauth-client",
    });
  });

  it("accepts a named static token and rejects all other values", async () => {
    const oauth = { async verifyAccessToken() { throw new Error("invalid"); } };
    const token = "A".repeat(48);
    const verifier = new MultiClientTokenVerifier(oauth, [{ clientId: "polaris", token }], resource);
    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      clientId: "static:polaris",
      scopes: ["mail:read", "mail:reply"],
      resource,
    });
    await expect(verifier.verifyAccessToken("B".repeat(48))).rejects.toThrow("Invalid access token");
  });
});
