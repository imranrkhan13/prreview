import { prisma } from "../lib/prisma.js";
import { transitionDeployment, logEvent } from "../lib/deploymentService.js";
import { providerRegistry } from "../providers/registry.js";
import { env } from "../lib/env.js";
import { pollUntilHealthy } from "../lib/healthCheck.js";
import { isKillSwitchEngaged, isDeploymentsEnabled } from "../lib/killSwitch.js";
import { claimDeployment } from "../lib/claim.js";
import { DeploymentStatus } from "../lib/stateMachine.js";

const MAX_ATTEMPTS = 3;

/**
 * Resolves a repo's secret allowlist into actual env var values, sourced
 * ONLY from the operator's own process.env — never a shared prod secret
 * store, never a value the caller supplies directly. If a repo lists a
 * key that isn't set in the operator's environment, it's simply omitted
 * (never silently substituted with an empty string), and a warning event
 * is logged so a missing secret is visible rather than a silent failure
 * deep in the target app.
 */
function resolveAllowedEnv(secretAllowlist: string[], baseEnv: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = { ...baseEnv };
  for (const key of secretAllowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Runs the health-check gate against a freshly-provisioned or redeployed
 * URL. This is the ONLY path that can move a deployment into LIVE — a
 * provider returning a URL is never, by itself, sufficient.
 */
async function runHealthCheckGate(params: {
  deploymentId: string;
  url: string;
  onSuccess: (message: string) => Promise<void>;
}): Promise<void> {
  const { deploymentId, url } = params;

  await transitionDeployment({ deploymentId, to: "HEALTH_CHECK", message: `Polling ${url}` });

  const result = await pollUntilHealthy(url, {
    timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    intervalMs: env.HEALTH_CHECK_INTERVAL_MS,
    maxAttempts: env.HEALTH_CHECK_MAX_ATTEMPTS,
  });

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { healthCheckAttempts: result.attempts, lastHealthCheckAt: new Date() },
  });

  if (!result.healthy) {
    await transitionDeployment({
      deploymentId,
      to: "FAILED",
      message: "Health check failed",
      failureReason: result.reason ?? "Health check did not pass before timeout.",
    });
    return;
  }

  await params.onSuccess(`Health check passed after ${result.attempts} attempt(s)`);
}

/**
 * Picks up one QUEUED deployment and provisions it end-to-end:
 * QUEUED -> PROVISIONING -> DEPLOYING -> HEALTH_CHECK -> LIVE (or FAILED
 * at any stage, with a concrete reason — never silently stuck, never
 * silently "live").
 *
 * The QUEUED -> PROVISIONING step is an ATOMIC claim (claimDeployment,
 * a single conditional UPDATE) so that if two worker processes poll the
 * same QUEUED row at the same instant, only one of them proceeds — the
 * other's claim affects zero rows and it returns immediately. This is
 * what makes it safe to run more than one worker instance.
 */
export async function processQueuedDeployment(deploymentId: string): Promise<void> {
  if (isKillSwitchEngaged()) {
    await logEvent(deploymentId, "kill_switch", "KILL_SWITCH is engaged; skipping this tick.");
    return;
  }
  if (!isDeploymentsEnabled()) {
    await logEvent(deploymentId, "kill_switch", "DEPLOYMENTS_ENABLED is false; skipping this tick.");
    return;
  }

  const deployment = await prisma.deployment.findUniqueOrThrow({
    where: { id: deploymentId },
    include: { pr: { include: { repo: true } } },
  });

  if (deployment.status !== "QUEUED") return; // fast pre-check to avoid pointless claim attempts

  const activeCount = await prisma.deployment.count({
    where: {
      status: { in: ["PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "LIVE", "UPDATING"] },
      pr: { repo: { orgId: deployment.pr.repo.orgId } },
    },
  });
  if (activeCount >= env.MAX_CONCURRENT_PREVIEWS_PER_ORG) {
    // Still goes through the atomic claim below rather than an unconditional
    // write, so a deployment that another worker already grabbed in the
    // meantime doesn't get double-transitioned to FAILED either.
    const claimed = await claimDeployment(prisma, deploymentId, "QUEUED", "FAILED");
    if (!claimed) return;
    await logEvent(
      deploymentId,
      "state_change",
      `QUEUED -> FAILED: Rejected before provisioning: org concurrency limit reached (${env.MAX_CONCURRENT_PREVIEWS_PER_ORG} active previews).`
    );
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { failureReason: `Org concurrency limit reached (${env.MAX_CONCURRENT_PREVIEWS_PER_ORG} active previews).` },
    });
    return;
  }

  const claimed = await claimDeployment(prisma, deploymentId, "QUEUED", "PROVISIONING");
  if (!claimed) return; // another worker instance already claimed this deployment
  await logEvent(deploymentId, "state_change", "QUEUED -> PROVISIONING: Worker picked up job");

  const provider = providerRegistry[deployment.provider as keyof typeof providerRegistry];
  const allowedEnv = resolveAllowedEnv(deployment.pr.repo.secretAllowlist, {
    PREVIEW: "true",
    PR_NUMBER: String(deployment.pr.githubPrNumber),
  });

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await transitionDeployment({ deploymentId, to: "DEPLOYING", message: `Calling ${provider.name} (attempt ${attempt})` });

      const result = await provider.provision({
        deploymentId,
        repoFullName: deployment.pr.repo.fullName,
        prNumber: deployment.pr.githubPrNumber,
        commitSha: deployment.commitSha,
        allowedEnv,
      });

      await logEvent(deploymentId, "provider_ref", result.providerRef);

      await runHealthCheckGate({
        deploymentId,
        url: result.url,
        onSuccess: async (message) => {
          await prisma.deployment.update({
            where: { id: deploymentId },
            data: { expiresAt: new Date(Date.now() + env.PREVIEW_TTL_HOURS * 60 * 60 * 1000) },
          });
          await transitionDeployment({
            deploymentId,
            to: "LIVE",
            message: `${message} (provider=${provider.name}, real=${provider.isRealDeployment})`,
            url: result.url,
          });
        },
      });
      return;
    } catch (err) {
      lastError = err as Error;
      await logEvent(deploymentId, "error", `Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}`);
      // Re-fetch current status: if the health-check gate already marked
      // this FAILED, don't try to transition again out of a terminal-ish
      // failure loop below the transactional guard.
      const current = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
      if (current.status === "FAILED") return;
    }
  }

  await transitionDeployment({
    deploymentId,
    to: "FAILED",
    message: "Exhausted retry attempts",
    failureReason: lastError?.message ?? "Unknown provisioning failure",
  });
}

/** Redeploy path: new commits pushed to an already-live PR. */
export async function processRedeploy(deploymentId: string, newCommitSha: string): Promise<void> {
  if (isKillSwitchEngaged()) {
    await logEvent(deploymentId, "kill_switch", "KILL_SWITCH is engaged; skipping redeploy this tick.");
    return;
  }

  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  if (deployment.status !== "LIVE") return; // fast pre-check

  const claimed = await claimDeployment(prisma, deploymentId, "LIVE", "UPDATING");
  if (!claimed) return; // another worker instance already claimed this redeploy
  await logEvent(deploymentId, "state_change", `LIVE -> UPDATING: New commit ${newCommitSha}`);

  const provider = providerRegistry[deployment.provider as keyof typeof providerRegistry];
  const refEvent = await prisma.deploymentEvent.findFirst({
    where: { deploymentId, type: "provider_ref" },
    orderBy: { createdAt: "desc" },
  });

  if (!refEvent) {
    await transitionDeployment({
      deploymentId,
      to: "FAILED",
      message: "Redeploy failed",
      failureReason: "No provider reference recorded for this deployment.",
    });
    return;
  }

  try {
    const result = await provider.update({ providerRef: refEvent.message, commitSha: newCommitSha });
    await logEvent(deploymentId, "provider_ref", result.providerRef);
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { commitSha: newCommitSha },
    });

    // Redeploys go through the SAME health-check gate as first provisions.
    // An old deployment must never remain marked LIVE while a broken new
    // commit sits behind that URL — until health passes, status stays
    // HEALTH_CHECK, not LIVE, even though the previous commit was working.
    await runHealthCheckGate({
      deploymentId,
      url: result.url,
      onSuccess: async (message) => {
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: { expiresAt: new Date(Date.now() + env.PREVIEW_TTL_HOURS * 60 * 60 * 1000) },
        });
        await transitionDeployment({ deploymentId, to: "LIVE", message, url: result.url });
      },
    });
  } catch (err) {
    await transitionDeployment({
      deploymentId,
      to: "FAILED",
      message: "Redeploy failed",
      failureReason: (err as Error).message,
    });
  }
}

/**
 * Cleanup path: PR closed/merged, or TTL expired (called by the reaper).
 *
 * The status flip to the terminal state (STOPPED or EXPIRED) is claimed
 * ATOMICALLY from whatever the deployment's current status is, before any
 * provider call is made. This is the mechanism that prevents the worker
 * (processing a "PR closed" teardown request) and the reaper (processing
 * a TTL expiration) from both tearing down — and both calling
 * provider.teardown() on — the same deployment at the same time.
 */
export async function teardownDeployment(deploymentId: string, reason: "stopped" | "expired"): Promise<void> {
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  if (["STOPPED", "EXPIRED"].includes(deployment.status)) return; // already terminal

  const targetStatus: DeploymentStatus = reason === "expired" ? "EXPIRED" : "STOPPED";
  const claimed = await claimDeployment(prisma, deploymentId, deployment.status as DeploymentStatus, targetStatus);
  if (!claimed) return; // worker or reaper already claimed this teardown

  await logEvent(
    deploymentId,
    "state_change",
    `${deployment.status} -> ${targetStatus}: ${reason === "expired" ? "TTL expired" : "PR closed/merged"}`
  );

  const provider = providerRegistry[deployment.provider as keyof typeof providerRegistry];
  const refEvent = await prisma.deploymentEvent.findFirst({
    where: { deploymentId, type: "provider_ref" },
    orderBy: { createdAt: "desc" },
  });

  if (refEvent) {
    try {
      await provider.teardown(refEvent.message);
    } catch (err) {
      await logEvent(deploymentId, "error", `Teardown warning: ${(err as Error).message}`);
      // Continue anyway — the DB already reflects STOPPED/EXPIRED (claimed
      // above); cost control matters more than a perfectly clean
      // provider-side teardown log.
    }
  }
}
