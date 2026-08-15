import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { teardownDeployment } from "../worker/processDeployment.js";

async function reap(): Promise<void> {
  const expired = await prisma.deployment.findMany({
    where: {
      status: "LIVE",
      expiresAt: { lt: new Date() },
    },
    take: 20,
  });

  for (const d of expired) {
    // eslint-disable-next-line no-console
    console.log(`Reaping expired deployment ${d.id} (expired at ${d.expiresAt?.toISOString()})`);
    await teardownDeployment(d.id, "expired").catch((err) =>
      // eslint-disable-next-line no-console
      console.error(`Reap failed for ${d.id}`, err)
    );
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Reaper started. Sweeping every ${env.REAPER_INTERVAL_MS}ms, TTL=${env.PREVIEW_TTL_HOURS}h`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await reap().catch((err) => console.error("Reaper sweep failed", err));
    await new Promise((resolve) => setTimeout(resolve, env.REAPER_INTERVAL_MS));
  }
}

main();
