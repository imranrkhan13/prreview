/**
 * Creates one demo Organization + Repository + a demo User with Membership
 * so you can exercise the full webhook -> worker -> dashboard flow locally
 * without a real GitHub App installation or OAuth login.
 *
 * Prints two things ONCE:
 * - An automation API key (X-API-Key), for scripts/verify-production.js
 *   and other non-dashboard automation. Store it, only its hash is kept.
 * - A ready-to-use dashboard SESSION TOKEN for the demo user, so you can
 *   open the dashboard immediately without going through real GitHub
 *   OAuth. Paste it into sessionStorage as `prpreview_session_token`, or
 *   use it directly as an Authorization: Bearer header for manual testing.
 *
 * Usage: npx tsx scripts/seed-demo-org.ts
 */
import { randomBytes, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createSessionToken } from "../src/lib/auth/session.js";

const prisma = new PrismaClient();

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function main() {
  const apiKey = "prpk_" + randomBytes(24).toString("hex");

  const org = await prisma.organization.create({
    data: {
      githubOrgId: BigInt(Date.now()), // placeholder unique id for demo purposes
      name: "Demo Org",
      apiKeyHash: hashKey(apiKey),
    },
  });

  const repo = await prisma.repository.create({
    data: {
      orgId: org.id,
      githubRepoId: BigInt(Date.now() + 1),
      fullName: "demo-org/sample-app",
      installationId: BigInt(1),
      allowed: true, // pre-approved for the demo walkthrough
      webhookSecretRef: "GITHUB_WEBHOOK_SECRET", // points at the env var name, never the raw secret
    },
  });

  const user = await prisma.user.create({
    data: {
      githubUserId: BigInt(Date.now() + 2), // placeholder; a real login links via GitHub OAuth instead
      login: "demo-user",
    },
  });

  await prisma.membership.create({
    data: { userId: user.id, orgId: org.id, role: "OWNER" },
  });

  const sessionSecret = process.env.SESSION_SECRET || "insecure-dev-only-session-secret-do-not-use-in-production";
  const session = createSessionToken({
    userId: user.id,
    secret: sessionSecret,
    ttlSeconds: 60 * 60 * 24 * 7, // 7 days, matches the default SESSION_TTL_SECONDS
  });

  console.log("Demo org created:");
  console.log(`  org id:      ${org.id}`);
  console.log(`  repo id:     ${repo.id} (${repo.fullName})`);
  console.log(`  user id:     ${user.id} (${user.login})`);
  console.log(`  automation API key: ${apiKey}`);
  console.log(`  dashboard session token: ${session.token}`);
  console.log(
    "\nDashboard: paste the session token into your browser's sessionStorage under key " +
      "'prpreview_session_token' (DevTools -> Application -> Session Storage), then reload."
  );
  console.log("Automation: use the API key as an X-API-Key header.");
  console.log("Both are printed only this once.");
  if (!process.env.SESSION_SECRET) {
    console.log(
      "\n⚠ SESSION_SECRET is not set in your environment -- this token was signed with the " +
        "insecure dev-only default. It will only verify against a server ALSO running without " +
        "SESSION_SECRET set. Set SESSION_SECRET in both places for anything beyond local scratch testing."
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
