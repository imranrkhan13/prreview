#!/usr/bin/env node
/**
 * Runs before `prisma migrate deploy` in Railway's pre-deploy step.
 * Exists specifically because of a real incident: `migrate deploy` failed
 * with P3018 ("type Role already exists") because the database had been
 * synced with `prisma db push` and the one-time
 * `prisma migrate resolve --applied 0_baseline` step was never run first.
 * That failure stopped the container with a cryptic Postgres error and no
 * guidance.
 *
 * This script's job is narrow and deliberately conservative: detect that
 * situation and FAIL LOUDLY WITH INSTRUCTIONS rather than attempt any
 * automatic fix. Marking a migration as "applied" without a human
 * confirming the live schema actually matches is exactly the kind of
 * blind automation that caused the incident in the first place — this
 * script never does that for you.
 *
 * Usage: node scripts/check-migration-baseline.js
 * (wired into package.json as `prisma:preflight`, called before
 * `prisma:deploy` in Railway's pre-deploy command — see README.)
 */
import { execFileSync } from "node:child_process";

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[migration-preflight] DATABASE_URL is not set. Refusing to proceed.");
    process.exit(1);
  }

  let statusOutput;
  try {
    statusOutput = run("npx", ["prisma", "migrate", "status"]);
  } catch (err) {
    // `prisma migrate status` itself exits non-zero when there's a failed
    // migration or drift — that's the signal we care about. Capture its
    // stdout/stderr either way rather than trusting the exit code alone,
    // since Prisma's CLI exit codes for this command have not been
    // exhaustively verified against every version in this environment.
    statusOutput = (err.stdout ?? "") + (err.stderr ?? "");
  }

  console.log(statusOutput);

  const hasFailedMigration = /following migration.*failed|migrate resolve/i.test(statusOutput);
  const hasDrift = /drift detected|schema is not in sync/i.test(statusOutput);

  // Honesty note: these patterns were written from Prisma's documented CLI
  // output conventions, not verified against a live failed-migration run
  // of this exact Prisma version (this sandbox has no database to trigger
  // one against). If the wording differs and this check under-detects a
  // problem, the full `prisma migrate status` output is still printed
  // above unconditionally — a human reading Railway's build logs will
  // still see the real error either way. This script is a safety net on
  // top of that, not a replacement for it.
  if (hasFailedMigration || hasDrift) {
    console.error("");
    console.error("=".repeat(78));
    console.error("[migration-preflight] BLOCKING DEPLOY: migration state needs manual review.");
    console.error("=".repeat(78));
    console.error("");

    // Read-only diagnostic: shows exactly what would need to change to
    // reconcile the live DB with the Prisma schema, saved to the deploy
    // log automatically so a human reviewing it doesn't have to run this
    // command separately from their own machine before deciding whether
    // `--applied` is safe. This NEVER runs `migrate resolve` itself —
    // that decision stays a manual, human step per the incident recovery
    // process in the README.
    console.error("--- Schema diff (live DB vs prisma/schema.prisma), for reference only ---");
    try {
      const diffOutput = run("npx", [
        "prisma",
        "migrate",
        "diff",
        "--from-url",
        process.env.DATABASE_URL,
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--script",
      ]);
      console.error(diffOutput.trim() || "(no output — likely means schema already matches)");
    } catch (diffErr) {
      console.error(`Could not run migrate diff for reference: ${diffErr.message}`);
    }
    console.error("--- End schema diff ---");
    console.error("");

    console.error("This is not something this script will fix automatically — see README");
    console.error('"Migration strategy" and the incident recovery sequence for exact steps:');
    console.error("");
    console.error("  1. Back up the database (Neon branch or pg_dump) before anything else.");
    console.error("  2. npx prisma migrate resolve --rolled-back <migration_name>   (if failed)");
    console.error("  3. Review the schema diff printed above. If it's empty/no-op, the live");
    console.error("     schema already matches and it's safe to continue to step 4.");
    console.error("  4. npx prisma migrate resolve --applied <migration_name>");
    console.error("  5. npx prisma migrate status   (confirm clean)");
    console.error("");
    console.error("Deploy is intentionally blocked until this is resolved by a human.");
    process.exit(1);
  }

  console.log("[migration-preflight] Migration state looks clean. Proceeding.");
}

main();
