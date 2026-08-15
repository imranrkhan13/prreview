import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { processQueuedDeployment, processRedeploy, teardownDeployment } from "./processDeployment.js";

/**
 * Deliberately simple polling loop instead of a Redis-backed queue
 * (BullMQ/etc). At MVP scale this is easier to run and reason about — one
 * fewer stateful service to operate — and Postgres is already the source
 * of truth for deployment status, so polling it directly avoids a second
 * system that can drift out of sync with the DB. Revisit if throughput
 * requires it.
 */
async function tick(): Promise<void> {
  const queued = await prisma.deployment.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  for (const d of queued) {
    await processQueuedDeployment(d.id).catch((err) =>
      // eslint-disable-next-line no-console
      console.error(`processQueuedDeployment(${d.id}) failed`, err)
    );
  }

  // Redeploy: a LIVE deployment whose PR head SHA has moved on.
  const liveWithStaleCommit = await prisma.deployment.findMany({
    where: { status: "LIVE" },
    include: { pr: true },
    take: 5,
  });
  for (const d of liveWithStaleCommit) {
    if (d.pr.headSha !== d.commitSha) {
      await processRedeploy(d.id, d.pr.headSha).catch((err) =>
        // eslint-disable-next-line no-console
        console.error(`processRedeploy(${d.id}) failed`, err)
      );
    }
  }

  // Teardown requested via webhook (PR closed/merged).
  const teardownRequests = await prisma.deploymentEvent.findMany({
    where: { type: "teardown_requested" },
    take: 5,
    orderBy: { createdAt: "asc" },
  });
  for (const evt of teardownRequests) {
    await teardownDeployment(evt.deploymentId, "stopped").catch((err) =>
      // eslint-disable-next-line no-console
      console.error(`teardownDeployment(${evt.deploymentId}) failed`, err)
    );
    // Consume the request so we don't reprocess it every tick.
    await prisma.deploymentEvent.delete({ where: { id: evt.id } }).catch(() => undefined);
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Worker started. Polling every ${env.WORKER_POLL_INTERVAL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((err) => console.error("Worker tick failed", err));
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }
}

main();
