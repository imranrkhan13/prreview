import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { assertLegalTransition, DeploymentStatus } from "./stateMachine.js";

/**
 * Every status change goes through this function so that:
 * 1. Illegal transitions are rejected (see stateMachine.ts)
 * 2. A DeploymentEvent row is always written alongside the status change,
 *    so the UI always has a visible audit trail — no silent status flips.
 */
export async function transitionDeployment(params: {
  deploymentId: string;
  to: DeploymentStatus;
  message: string;
  url?: string;
  failureReason?: string;
}): Promise<void> {
  const { deploymentId, to, message, url, failureReason } = params;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const deployment = await tx.deployment.findUniqueOrThrow({ where: { id: deploymentId } });

    assertLegalTransition(deployment.status as DeploymentStatus, to);

    await tx.deployment.update({
      where: { id: deploymentId },
      data: {
        status: to,
        ...(url !== undefined ? { url } : {}),
        ...(to === "FAILED" ? { failureReason: failureReason ?? "Unknown failure" } : {}),
        ...(to !== "FAILED" ? { failureReason: null } : {}),
      },
    });

    await tx.deploymentEvent.create({
      data: {
        deploymentId,
        type: "state_change",
        message: `${deployment.status} -> ${to}: ${message}`,
      },
    });
  });
}

export async function logEvent(deploymentId: string, type: string, message: string): Promise<void> {
  await prisma.deploymentEvent.create({
    data: { deploymentId, type, message },
  });
}
