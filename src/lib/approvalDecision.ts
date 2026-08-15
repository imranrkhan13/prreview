/**
 * Pure decision logic for the fork-PR approval flow. Extracted from the
 * Fastify route (dashboardApi.ts) so the authorization rules themselves
 * are unit-testable without a live DB. The route re-derives every input
 * to this function from the database on each request — it never trusts a
 * client-supplied flag — this module documents and tests exactly which
 * DB facts it checks.
 */

export interface ApprovalContext {
  /** Was this PR row found scoped to the requesting org's data at all? */
  prFoundInRequestingOrg: boolean;
  /** Does the PR's current DB state say it's actually pending approval? */
  needsApproval: boolean;
  /** Is there already a non-terminal deployment for this PR? */
  hasActiveDeployment: boolean;
}

export type ApprovalDecision =
  | { allowed: true }
  | { allowed: false; status: 404 | 400 | 409; reason: string };

/**
 * Whether an incoming PR requires manual approval before a deployment is
 * auto-created. Same-repo branch PRs never need approval (only
 * collaborators can push to them); fork PRs need approval unless the repo
 * owner has explicitly opted in via `allowForkPrs`.
 */
export function computeNeedsApproval(isFork: boolean, allowForkPrs: boolean): boolean {
  return isFork && !allowForkPrs;
}

/**
 * Re-checks authorization server-side from DB-derived facts only — never
 * from anything the client asserts about itself. A request for a PR that
 * doesn't resolve inside the caller's own org (wrong org's API key, or a
 * fabricated PR id) is indistinguishable from "not found", which is the
 * correct response for both "doesn't exist" and "you can't see this" —
 * it doesn't leak which case it is.
 */
export function decideApproval(ctx: ApprovalContext): ApprovalDecision {
  if (!ctx.prFoundInRequestingOrg) {
    return { allowed: false, status: 404, reason: "Pull request not found" };
  }
  if (!ctx.needsApproval) {
    return { allowed: false, status: 400, reason: "This PR does not require approval" };
  }
  if (ctx.hasActiveDeployment) {
    return { allowed: false, status: 409, reason: "A deployment is already active for this PR" };
  }
  return { allowed: true };
}
