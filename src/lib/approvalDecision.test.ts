import { describe, it, expect } from "vitest";
import { decideApproval, computeNeedsApproval } from "./approvalDecision.js";

describe("computeNeedsApproval — fork gating on webhook ingestion", () => {
  it("same-repo branch PRs never need approval", () => {
    expect(computeNeedsApproval(false, false)).toBe(false);
    expect(computeNeedsApproval(false, true)).toBe(false);
  });

  it("fork PRs need approval by default", () => {
    expect(computeNeedsApproval(true, false)).toBe(true);
  });

  it("fork PRs skip approval when the repo owner opts in", () => {
    expect(computeNeedsApproval(true, true)).toBe(false);
  });
});

describe("decideApproval — fork PR approval authorization", () => {
  it("allows approval when the PR belongs to the requesting org, needs approval, and has no active deployment", () => {
    const decision = decideApproval({
      prFoundInRequestingOrg: true,
      needsApproval: true,
      hasActiveDeployment: false,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("rejects an unauthorized attempt: a PR id that doesn't resolve inside the requester's own org", () => {
    // This is what happens when org A's API key is used to try to approve
    // a PR that belongs to org B — the org-scoped DB query in the route
    // returns null, which surfaces here as prFoundInRequestingOrg: false.
    const decision = decideApproval({
      prFoundInRequestingOrg: false,
      needsApproval: true, // irrelevant — never reached
      hasActiveDeployment: false,
    });
    expect(decision).toEqual({ allowed: false, status: 404, reason: "Pull request not found" });
  });

  it("rejects approving a PR that was never in an approval-needed state (e.g. a same-repo branch PR)", () => {
    const decision = decideApproval({
      prFoundInRequestingOrg: true,
      needsApproval: false,
      hasActiveDeployment: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.status).toBe(400);
    }
  });

  it("rejects a duplicate approval request once a deployment already exists (idempotency)", () => {
    // First approval succeeds and creates a deployment; needsApproval flips
    // to false on that same request. A second POST to /approve for the
    // same PR would now see needsApproval: false and get the 400 path
    // above — but simulate the race where two approvals land back-to-back
    // before the needsApproval flag updates: hasActiveDeployment already
    // catches it too.
    const decision = decideApproval({
      prFoundInRequestingOrg: true,
      needsApproval: true,
      hasActiveDeployment: true,
    });
    expect(decision).toEqual({
      allowed: false,
      status: 409,
      reason: "A deployment is already active for this PR",
    });
  });

  it("hasActiveDeployment is checked even when needsApproval is also true (concurrency-safe ordering)", () => {
    // Ensures the 409 (already active) check isn't accidentally
    // short-circuited by a true needsApproval — both conditions are real
    // DB facts and both must hold for approval to proceed.
    const decision = decideApproval({
      prFoundInRequestingOrg: true,
      needsApproval: true,
      hasActiveDeployment: true,
    });
    expect(decision.allowed).toBe(false);
  });
});
