import { DeploymentStatus } from "./stateMachine.js";

/**
 * Minimal shape of the Prisma deployment delegate this module needs —
 * declared narrowly so claimDeployment can be unit-tested against a plain
 * mock object instead of requiring a live Prisma client / database.
 */
export interface DeploymentUpdateManyClient {
  deployment: {
    updateMany(args: {
      where: { id: string; status: DeploymentStatus };
      data: { status: DeploymentStatus };
    }): Promise<{ count: number }>;
  };
}

/**
 * Atomically claims a deployment by flipping its status from `fromStatus`
 * to `toStatus`, but ONLY if it is still in `fromStatus` at the moment the
 * UPDATE runs. Postgres (and Prisma's generated SQL) executes this as a
 * single `UPDATE ... WHERE id = $1 AND status = $2` statement — the
 * database itself serializes concurrent attempts, so if two worker
 * processes (or a worker and the reaper) both try to claim the same
 * deployment at the same instant, exactly one UPDATE affects a row
 * (`count === 1`) and the other affects zero rows (`count === 0`).
 *
 * This is the mechanism that prevents duplicate processing / double
 * teardown without needing a separate lock table or advisory lock —
 * ordinary row-level locking inside a single atomic UPDATE is sufficient
 * here because every worker/reaper action is gated by exactly this call
 * before it does anything with side effects (calling a provider, etc).
 *
 * Returns true if THIS caller won the claim; false means some other
 * process already claimed it (or it was no longer in `fromStatus` for any
 * other reason) — the caller should simply skip it, not retry or error.
 */
export async function claimDeployment(
  client: DeploymentUpdateManyClient,
  deploymentId: string,
  fromStatus: DeploymentStatus,
  toStatus: DeploymentStatus
): Promise<boolean> {
  const result = await client.deployment.updateMany({
    where: { id: deploymentId, status: fromStatus },
    data: { status: toStatus },
  });
  return result.count === 1;
}
