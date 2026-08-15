import { describe, it, expect } from "vitest";
import { resolveAuth, isAuthorizedForOrg, AuthDbClient } from "./resolveAuth.js";
import { createSessionToken } from "./session.js";
import { hashKey } from "./apiKey.js";

const secret = "test-session-secret";

function makeFakeClient(params: {
  orgs?: { id: string; apiKeyHash: string }[];
  memberships?: { userId: string; orgId: string }[];
  revokedSids?: string[];
}): AuthDbClient {
  const orgs = params.orgs ?? [];
  const memberships = params.memberships ?? [];
  const revokedSids = new Set(params.revokedSids ?? []);
  return {
    organization: {
      async findFirst({ where }) {
        return orgs.find((o) => o.apiKeyHash === where.apiKeyHash) ?? null;
      },
    },
    membership: {
      async findMany({ where }) {
        return memberships.filter((m) => m.userId === where.userId).map((m) => ({ orgId: m.orgId }));
      },
    },
    revokedSession: {
      async findUnique({ where }) {
        return revokedSids.has(where.sid) ? { sid: where.sid } : null;
      },
    },
  };
}

describe("resolveAuth — session mode", () => {
  it("resolves a valid session token to the user's authorized org ids via Membership", async () => {
    const token = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const client = makeFakeClient({
      memberships: [
        { userId: "user_1", orgId: "org_A" },
        { userId: "user_1", orgId: "org_B" },
      ],
    });

    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: `Bearer ${token.token}`,
      apiKeyHeader: undefined,
    });

    expect(result).toEqual({
      authenticated: true,
      mode: "session",
      userId: "user_1",
      authorizedOrgIds: expect.arrayContaining(["org_A", "org_B"]),
    });
  });

  it("a user with no memberships gets an empty authorized org list, not an error", async () => {
    const token = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const client = makeFakeClient({ memberships: [] });
    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: `Bearer ${token.token}`,
      apiKeyHeader: undefined,
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) expect(result.authorizedOrgIds).toEqual([]);
  });

  it("rejects a revoked session (logged out) even with a validly-signed token", async () => {
    const token = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const client = makeFakeClient({
      memberships: [{ userId: "user_1", orgId: "org_A" }],
      revokedSids: [token.sid],
    });

    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: `Bearer ${token.token}`,
      apiKeyHeader: undefined,
    });

    expect(result).toEqual({ authenticated: false, status: 401, reason: "Session has been signed out" });
  });

  it("rejects an expired session with a distinct, user-actionable message", async () => {
    const token = createSessionToken({ userId: "user_1", secret, ttlSeconds: -1 });
    const client = makeFakeClient({});
    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: `Bearer ${token.token}`,
      apiKeyHeader: undefined,
    });
    expect(result).toEqual({ authenticated: false, status: 401, reason: "Session expired, please sign in again" });
  });

  it("rejects a session signed with the wrong secret", async () => {
    const token = createSessionToken({ userId: "user_1", secret: "other-secret", ttlSeconds: 3600 });
    const client = makeFakeClient({});
    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: `Bearer ${token.token}`,
      apiKeyHeader: undefined,
    });
    expect(result.authenticated).toBe(false);
  });
});

describe("resolveAuth — API key mode (automation/testing fallback)", () => {
  it("resolves a valid API key to exactly that org's id, single-org scoped", async () => {
    const apiKey = "prpk_" + "a".repeat(48);
    const client = makeFakeClient({ orgs: [{ id: "org_A", apiKeyHash: hashKey(apiKey) }] });

    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: undefined,
      apiKeyHeader: apiKey,
    });

    expect(result).toEqual({ authenticated: true, mode: "api_key", authorizedOrgIds: ["org_A"] });
  });

  it("rejects an API key that matches no org", async () => {
    const client = makeFakeClient({ orgs: [] });
    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: undefined,
      apiKeyHeader: "prpk_" + "z".repeat(48),
    });
    expect(result).toEqual({ authenticated: false, status: 401, reason: "Invalid API key" });
  });

  it("prefers session auth over API key auth when both headers are present", async () => {
    const token = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const apiKey = "prpk_" + "a".repeat(48);
    const client = makeFakeClient({
      orgs: [{ id: "org_from_api_key", apiKeyHash: hashKey(apiKey) }],
      memberships: [{ userId: "user_1", orgId: "org_from_session" }],
    });

    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: `Bearer ${token.token}`,
      apiKeyHeader: apiKey,
    });

    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.mode).toBe("session");
      expect(result.authorizedOrgIds).toEqual(["org_from_session"]);
    }
  });
});

describe("resolveAuth — no credentials", () => {
  it("rejects a request with neither header", async () => {
    const client = makeFakeClient({});
    const result = await resolveAuth(client, {
      sessionSecret: secret,
      authorizationHeader: undefined,
      apiKeyHeader: undefined,
    });
    expect(result).toEqual({
      authenticated: false,
      status: 401,
      reason: "Missing Authorization or X-API-Key header",
    });
  });
});

describe("isAuthorizedForOrg", () => {
  it("returns true only for an org id present in the resolved authorizedOrgIds", () => {
    const auth = { authenticated: true as const, mode: "session" as const, authorizedOrgIds: ["org_A", "org_B"] };
    expect(isAuthorizedForOrg(auth, "org_A")).toBe(true);
    expect(isAuthorizedForOrg(auth, "org_C")).toBe(false);
  });

  it("returns false for an unauthenticated result regardless of orgId", () => {
    const auth = { authenticated: false as const, status: 401 as const, reason: "x" };
    expect(isAuthorizedForOrg(auth, "org_A")).toBe(false);
  });
});
