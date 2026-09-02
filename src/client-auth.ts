import { createHash, timingSafeEqual } from "node:crypto";

import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

interface StaticClientToken {
  clientId: string;
  token: string;
}

interface StaticClientDigest {
  clientId: string;
  digest: Buffer;
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class MultiClientTokenVerifier implements OAuthTokenVerifier {
  private readonly staticClients: StaticClientDigest[];

  constructor(
    private readonly oauthVerifier: OAuthTokenVerifier,
    staticClients: StaticClientToken[],
    private readonly resource: URL,
  ) {
    this.staticClients = staticClients.map(({ clientId, token }) => ({
      clientId,
      digest: digestToken(token),
    }));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      return await this.oauthVerifier.verifyAccessToken(token);
    } catch {
      // Clients without an OAuth flow can use an operator-provisioned token.
    }

    const candidate = digestToken(token);
    let matchedClientId: string | undefined;
    for (const client of this.staticClients) {
      if (timingSafeEqual(candidate, client.digest)) {
        matchedClientId = client.clientId;
      }
    }
    if (!matchedClientId) {
      throw new InvalidTokenError("Invalid access token");
    }
    return {
      token,
      clientId: `static:${matchedClientId}`,
      scopes: ["mail:read", "mail:reply"],
      // Configured credentials remain valid until the operator removes them.
      // The SDK middleware requires a finite timestamp on every bearer token.
      expiresAt: 253_402_300_799,
      resource: this.resource,
    };
  }
}
