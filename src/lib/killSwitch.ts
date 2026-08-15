/**
 * Deliberately reads process.env directly, NOT the frozen `env` singleton
 * from lib/env.ts, so flipping these flags in the environment takes effect
 * on the worker's very next poll tick with no restart required.
 */

/** Emergency stop: nothing new provisions or redeploys. Existing LIVE deployments are left running. */
export function isKillSwitchEngaged(): boolean {
  return process.env.KILL_SWITCH === "true";
}

/** Feature flag: normal on/off control for whether deployments run at all (defaults to enabled). */
export function isDeploymentsEnabled(): boolean {
  return process.env.DEPLOYMENTS_ENABLED !== "false";
}
