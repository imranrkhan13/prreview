export type DeploymentStatus =
  | "QUEUED"
  | "PROVISIONING"
  | "DEPLOYING"
  | "HEALTH_CHECK"
  | "LIVE"
  | "UPDATING"
  | "FAILED"
  | "STOPPED"
  | "EXPIRED";

const LEGAL_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ["PROVISIONING", "FAILED", "STOPPED"],
  PROVISIONING: ["DEPLOYING", "FAILED", "STOPPED"],
  DEPLOYING: ["HEALTH_CHECK", "FAILED", "STOPPED"],
  // A deployment is NEVER allowed to jump straight from HEALTH_CHECK to
  // anything but LIVE or FAILED — this is the enforcement point for "never
  // silently convert a failed or timed-out deployment to live."
  HEALTH_CHECK: ["LIVE", "FAILED", "STOPPED"],
  LIVE: ["UPDATING", "STOPPED", "EXPIRED", "FAILED"],
  UPDATING: ["HEALTH_CHECK", "FAILED", "STOPPED"],
  FAILED: ["PROVISIONING", "STOPPED"], // allow retry from FAILED back to PROVISIONING
  STOPPED: [], // terminal
  EXPIRED: [], // terminal
};

export class IllegalTransitionError extends Error {
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Illegal deployment state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertLegalTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}
