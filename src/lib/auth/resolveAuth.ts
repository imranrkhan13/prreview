import { verifySessionToken } from "./session.js";
import { hashKey } from "./apiKey.js";

/**
 * This is THE authorization boundary for the public product: every
 * dashboard request resolves to a concrete set of org ids the caller is
 * actually authorized for, derived server-side from the database
 * (Membership rows for session auth, the API key's own org for
 * automation auth). Nothing here ever trusts an orgId, userId, or repoId
 * asserted by the client — those are only used AFTER this resolution, to
 * check "is the resource's real orgId in this caller's authorizedOrgIds",
 * never the other way around.
 */

export type AuthMode = "session" | "api_key";

export type ResolvedAuth =
  | { authenticated: true; mode: AuthMode; userId?: string; authorizedOrgIds: string[] }
  | { authenticated: false; status: 401; reason: string };

export interface AuthDbClient {
  organization: {
    findFirst(args: { where: { apiKeyHash: string } }): Promise<{ id: string } | null>;
  };
  membership: {
    findMany(args: { where: { userId: string } }): Promise<{ orgId: string }[]>;
  };
  revokedSession: {
    findUnique(args: { where: { sid: string } }): Promise<{ sid: string } | null>;
  };
}

export interface ResolveAuthParams {
  sessionSecret: string;
  authorizationHeader: string | string[] | undefined;
  apiKeyHeader: string | string[] | undefined;
}

/**
 * Tries session-token auth first (Authorization: Bearer ...), then falls
 * back to API-key auth (X-API-Key) for automation/testing. Session auth
 * is intentionally checked first since it's the primary mechanism for the
 * public product; API keys remain a secondary path, not the default.
 */
export async function resolveAuth(client: AuthDbClient, params: ResolveAuthParams): Promise<ResolvedAuth> {
  const { sessionSecret, authorizationHeader, apiKeyHeader } = params;

  if (typeof authorizationHeader === "string" && authorizationHeader.startsWith("Bearer ")) {
    const token = authorizationHeader.slice("Bearer ".length);
    const verified = verifySessionToken(token, sessionSecret);

    if (!verified.valid) {
      const reason =
        verified.reason === "expired" ? "Session expired, please sign in again" : "Invalid session token";
      return { authenticated: false, status: 401, reason };
    }

    const revoked = await client.revokedSession.findUnique({ where: { sid: verified.payload.sid } });
    if (revoked) {
      return { authenticated: false, status: 401, reason: "Session has been signed out" };
    }

    const memberships = await client.membership.findMany({ where: { userId: verified.payload.userId } });
    return {
      authenticated: true,
      mode: "session",
      userId: verified.payload.userId,
      authorizedOrgIds: memberships.map((m) => m.orgId),
    };
  }

  if (typeof apiKeyHeader === "string" && apiKeyHeader.length >= 20) {
    const org = await client.organization.findFirst({ where: { apiKeyHash: hashKey(apiKeyHeader) } });
    if (!org) {
      return { authenticated: false, status: 401, reason: "Invalid API key" };
    }
    return { authenticated: true, mode: "api_key", authorizedOrgIds: [org.id] };
  }

  return { authenticated: false, status: 401, reason: "Missing Authorization or X-API-Key header" };
}

/** True if `orgId` (a value read from the DATABASE, never from the client) is one the caller is authorized for. */
export function isAuthorizedForOrg(auth: ResolvedAuth, orgId: string): boolean {
  return auth.authenticated && auth.authorizedOrgIds.includes(orgId);
}
