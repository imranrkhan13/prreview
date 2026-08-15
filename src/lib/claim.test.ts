import { describe, it, expect } from "vitest";
import { claimDeployment, DeploymentUpdateManyClient } from "./claim.js";

/**
 * Simulates a Postgres table with exactly the semantics that matter here:
 * an UPDATE ... WHERE id = ? AND status = ? only affects a row if the
 * row's CURRENT status still matches at the moment the update runs.
 */
function makeFakeDb(initialStatus: string): DeploymentUpdateManyClient {
  let currentStatus = initialStatus;
  return {
    deployment: {
      async updateMany({ where, data }) {
        if (currentStatus === where.status) {
          currentStatus = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
}

describe("claimDeployment", () => {
  it("succeeds when the deployment is in the expected fromStatus", async () => {
    const db = makeFakeDb("QUEUED");
    const claimed = await claimDeployment(db, "d1", "QUEUED", "PROVISIONING");
    expect(claimed).toBe(true);
  });

  it("fails when the deployment is no longer in fromStatus", async () => {
    const db = makeFakeDb("PROVISIONING"); // already moved on
    const claimed = await claimDeployment(db, "d1", "QUEUED", "PROVISIONING");
    expect(claimed).toBe(false);
  });

  it("prevents a second concurrent claim from succeeding (the core race condition this exists to prevent)", async () => {
    const db = makeFakeDb("QUEUED");

    // Simulate two worker processes racing to claim the same deployment.
    // With a real Postgres UPDATE, exactly one of these two concurrent
    // statements affects a row; this fake DB models that by only allowing
    // the transition once, from whichever call "runs" first.
    const [first, second] = await Promise.all([
      claimDeployment(db, "d1", "QUEUED", "PROVISIONING"),
      claimDeployment(db, "d1", "QUEUED", "PROVISIONING"),
    ]);

    // Exactly one caller should have won the claim.
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("prevents the worker and reaper from both tearing down the same LIVE deployment", async () => {
    const db = makeFakeDb("LIVE");

    const [workerClaim, reaperClaim] = await Promise.all([
      claimDeployment(db, "d1", "LIVE", "STOPPED"),
      claimDeployment(db, "d1", "LIVE", "EXPIRED"),
    ]);

    // Only one of "closed by user" (STOPPED) or "TTL expired" (EXPIRED)
    // should win — never both, and the deployment never ends up processed
    // twice.
    expect([workerClaim, reaperClaim].filter(Boolean)).toHaveLength(1);
  });
});
