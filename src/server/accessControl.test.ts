import { describe, it, expect } from "vitest";
import { resolveOrgAuth, hashKey, OrgLookupClient } from "./accessControl.js";

function makeFakeOrgTable(orgs: { id: string; apiKeyHash: string }[]): OrgLookupClient {
  return {
    organization: {
      async findFirst({ where }) {
        return orgs.find((o) => o.apiKeyHash === where.apiKeyHash) ?? null;
      },
    },
  };
}

describe("resolveOrgAuth — cross-org access boundary", () => {
  const orgAKey = "prpk_" + "a".repeat(48);
  const orgBKey = "prpk_" + "b".repeat(48);
  const client = makeFakeOrgTable([
    { id: "org_A", apiKeyHash: hashKey(orgAKey) },
    { id: "org_B", apiKeyHash: hashKey(orgBKey) },
  ]);

  it("resolves org A's key to org A's id only", async () => {
    const result = await resolveOrgAuth(client, orgAKey);
    expect(result).toEqual({ authorized: true, orgId: "org_A" });
  });

  it("resolves org B's key to org B's id only — never org A's, even though both exist", async () => {
    const result = await resolveOrgAuth(client, orgBKey);
    expect(result).toEqual({ authorized: true, orgId: "org_B" });
  });

  it("rejects a key that doesn't match any org's hash (cross-org / fabricated key denial)", async () => {
    const result = await resolveOrgAuth(client, "prpk_" + "z".repeat(48));
    expect(result).toEqual({ authorized: false, status: 401, reason: "Invalid API key" });
  });

  it("rejects a missing X-API-Key header", async () => {
    const result = await resolveOrgAuth(client, undefined);
    expect(result.authorized).toBe(false);
  });

  it("rejects a malformed/too-short header value without querying the DB", async () => {
    let queried = false;
    const trackedClient: OrgLookupClient = {
      organization: {
        async findFirst() {
          queried = true;
          return null;
        },
      },
    };
    const result = await resolveOrgAuth(trackedClient, "short");
    expect(result.authorized).toBe(false);
    expect(queried).toBe(false);
  });

  it("rejects an array header value (header injection / repeated-header edge case)", async () => {
    const result = await resolveOrgAuth(client, [orgAKey, orgBKey]);
    expect(result.authorized).toBe(false);
  });

  it("never authorizes based on a raw key match — only the hash", async () => {
    // If someone's key IS the hash value itself (not the raw key), that
    // must NOT authorize — proves lookups go through hashKey(), not a
    // direct comparison against stored data.
    const client2 = makeFakeOrgTable([{ id: "org_A", apiKeyHash: hashKey(orgAKey) }]);
    const result = await resolveOrgAuth(client2, hashKey(orgAKey));
    expect(result.authorized).toBe(false);
  });
});
