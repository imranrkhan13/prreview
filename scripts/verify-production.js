#!/usr/bin/env node
/**
 * Verifies a DEPLOYED prpreview instance from the outside — real HTTP
 * requests against the live Railway API and (for CORS) the live Vercel
 * origin. This is intentionally separate from `npm test`, which only
 * exercises code-level logic; this script is the thing that actually
 * proves the deployed system behaves as documented.
 *
 * SAFE BY DESIGN:
 * - Every secret/URL comes from an environment variable. Nothing is
 *   hardcoded. Missing optional vars SKIP that check with a clear reason
 *   rather than failing or silently using a fake value.
 * - Never prints the value of any secret, key, or webhook payload —
 *   only pass/fail/skip and short diagnostic messages.
 * - Read-only wherever possible. The only mutating calls are the
 *   documented ones needed to prove a real path works (a webhook POST
 *   with a deliberately WRONG signature, which must be rejected; a
 *   webhook POST with a valid signature IF GITHUB_WEBHOOK_SECRET and
 *   TEST_INSTALLATION_PAYLOAD are both provided).
 *
 * Required env vars:
 *   RAILWAY_API_URL       e.g. https://RAILWAYAPIURL
 *   VERCEL_ORIGIN         e.g. https://VERCELORIGIN  (must match DASHBOARD_ORIGIN)
 *   TEST_API_KEY          a real prpk_... key for one seeded test org
 *
 * Optional env vars (checks SKIP cleanly if absent):
 *   TEST_API_KEY_ORG_B         a second org's key, to prove cross-org denial
 *   TEST_REPO_ID               a repo id visible to TEST_API_KEY, to test /prs
 *   GITHUB_WEBHOOK_SECRET       to test that a validly-signed webhook is accepted
 *   TEST_INSTALLATION_PAYLOAD  JSON string: a realistic installation webhook body
 *   UNAPPROVED_ORIGIN          defaults to "https://evil.example.com" if unset
 *
 * Usage:
 *   RAILWAY_API_URL=https://RAILWAYAPIURL \
 *   VERCEL_ORIGIN=https://VERCELORIGIN \
 *   TEST_API_KEY=TESTAPIKEY \
 *   node scripts/verify-production.js
 */
import { createHmac } from "node:crypto";

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "✓" : status === "SKIP" ? "○" : "✗";
  console.log(`[${icon} ${status}] ${name}${detail ? " — " + detail : ""}`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main() {
  const apiUrl = requireEnv("RAILWAY_API_URL").replace(/\/+$/, "");
  const vercelOrigin = requireEnv("VERCEL_ORIGIN").replace(/\/+$/, "");
  const testApiKey = requireEnv("TEST_API_KEY");
  const testApiKeyOrgB = process.env.TEST_API_KEY_ORG_B;
  const testRepoId = process.env.TEST_REPO_ID;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const testInstallationPayload = process.env.TEST_INSTALLATION_PAYLOAD;
  const unapprovedOrigin = process.env.UNAPPROVED_ORIGIN || "https://evil.example.com";

  console.log(`Verifying deployed instance at ${apiUrl}\n`);

  // --- /health ---
  try {
    const res = await fetch(`${apiUrl}/health`);
    if (res.status === 200) {
      record("GET /health", "PASS", `HTTP ${res.status}`);
    } else {
      record("GET /health", "FAIL", `expected 200, got ${res.status}`);
    }
  } catch (err) {
    record("GET /health", "FAIL", `network error: ${err.message}`);
  }

  // --- /ready ---
  try {
    const res = await fetch(`${apiUrl}/ready`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body.database === "connected") {
      record("GET /ready", "PASS", "database: connected");
    } else {
      record("GET /ready", "FAIL", `HTTP ${res.status}, database=${body.database ?? "unknown"}`);
    }
  } catch (err) {
    record("GET /ready", "FAIL", `network error: ${err.message}`);
  }

  // --- unauthenticated request returns 401 ---
  try {
    const res = await fetch(`${apiUrl}/api/repos`);
    if (res.status === 401) {
      record("Unauthenticated /api/repos returns 401", "PASS");
    } else {
      record("Unauthenticated /api/repos returns 401", "FAIL", `got HTTP ${res.status} instead`);
    }
  } catch (err) {
    record("Unauthenticated /api/repos returns 401", "FAIL", `network error: ${err.message}`);
  }

  // --- authenticated request works ---
  let orgARepos = null;
  try {
    const res = await fetch(`${apiUrl}/api/repos`, { headers: { "X-API-Key": testApiKey } });
    if (res.status === 200) {
      orgARepos = await res.json();
      record("Authenticated /api/repos with TEST_API_KEY", "PASS", `${orgARepos.length} repo(s) returned`);
    } else {
      record("Authenticated /api/repos with TEST_API_KEY", "FAIL", `got HTTP ${res.status}`);
    }
  } catch (err) {
    record("Authenticated /api/repos with TEST_API_KEY", "FAIL", `network error: ${err.message}`);
  }

  // --- cross-org access denied ---
  if (!testApiKeyOrgB) {
    record("Cross-org access denied", "SKIP", "set TEST_API_KEY_ORG_B to run this check");
  } else if (!testRepoId) {
    record("Cross-org access denied", "SKIP", "set TEST_REPO_ID (a repo belonging to TEST_API_KEY's org) to run this check");
  } else {
    try {
      const res = await fetch(`${apiUrl}/api/repos/${encodeURIComponent(testRepoId)}/prs`, {
        headers: { "X-API-Key": testApiKeyOrgB },
      });
      if (res.status === 404) {
        record("Cross-org access denied", "PASS", "org B's key cannot see org A's repo (404, as designed)");
      } else {
        record("Cross-org access denied", "FAIL", `expected 404, got HTTP ${res.status} — possible cross-org leak`);
      }
    } catch (err) {
      record("Cross-org access denied", "FAIL", `network error: ${err.message}`);
    }
  }

  // --- CORS allows the production Vercel origin ---
  try {
    const res = await fetch(`${apiUrl}/api/repos`, {
      method: "OPTIONS",
      headers: {
        Origin: vercelOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-API-Key",
      },
    });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    if (allowOrigin === vercelOrigin) {
      record("CORS preflight allows VERCEL_ORIGIN", "PASS", `Access-Control-Allow-Origin: ${allowOrigin}`);
    } else {
      record("CORS preflight allows VERCEL_ORIGIN", "FAIL", `Access-Control-Allow-Origin was "${allowOrigin}"`);
    }
  } catch (err) {
    record("CORS preflight allows VERCEL_ORIGIN", "FAIL", `network error: ${err.message}`);
  }

  // --- CORS rejects an unapproved origin ---
  // Note: Node's fetch does NOT enforce CORS (that's a browser-only
  // mechanism) — this check works by inspecting the
  // Access-Control-Allow-Origin response header directly, the same way a
  // server-side test has to. A network-level failure here is a genuine
  // FAIL (can't verify), not evidence of rejection.
  try {
    const res = await fetch(`${apiUrl}/api/repos`, {
      method: "OPTIONS",
      headers: {
        Origin: unapprovedOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-API-Key",
      },
    });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    if (allowOrigin === unapprovedOrigin) {
      record("CORS rejects unapproved origin", "FAIL", `unapproved origin was echoed back and allowed`);
    } else {
      record("CORS rejects unapproved origin", "PASS", `Access-Control-Allow-Origin was NOT set to the unapproved origin (got "${allowOrigin}")`);
    }
  } catch (err) {
    record("CORS rejects unapproved origin", "FAIL", `network error: ${err.message}`);
  }

  // --- malformed webhook signature is rejected ---
  try {
    const body = JSON.stringify({ action: "opened", test: true });
    const res = await fetch(`${apiUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": `verify-script-bad-sig-${Date.now()}`,
        "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });
    if (res.status === 401) {
      record("Malformed webhook signature rejected", "PASS", "HTTP 401 as expected");
    } else {
      record("Malformed webhook signature rejected", "FAIL", `expected 401, got HTTP ${res.status}`);
    }
  } catch (err) {
    record("Malformed webhook signature rejected", "FAIL", `network error: ${err.message}`);
  }

  // --- valid installation webhook is accepted (and duplicate delivery is idempotent) ---
  if (!webhookSecret || !testInstallationPayload) {
    record(
      "Valid installation webhook accepted + duplicate delivery idempotent",
      "SKIP",
      "set GITHUB_WEBHOOK_SECRET and TEST_INSTALLATION_PAYLOAD to run this check"
    );
  } else {
    try {
      const deliveryId = `verify-script-${Date.now()}`;
      const sig = "sha256=" + createHmac("sha256", webhookSecret).update(testInstallationPayload).digest("hex");
      const headers = {
        "Content-Type": "application/json",
        "X-GitHub-Event": "installation",
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": sig,
      };

      const first = await fetch(`${apiUrl}/webhooks/github`, { method: "POST", headers, body: testInstallationPayload });
      const second = await fetch(`${apiUrl}/webhooks/github`, { method: "POST", headers, body: testInstallationPayload });
      const secondBody = await second.json().catch(() => ({}));

      if (first.status === 200 && second.status === 200 && secondBody.status === "duplicate_ignored") {
        record("Valid installation webhook accepted + duplicate delivery idempotent", "PASS");
      } else {
        record(
          "Valid installation webhook accepted + duplicate delivery idempotent",
          "FAIL",
          `first=${first.status}, second=${second.status}, secondBody.status=${secondBody.status}`
        );
      }
    } catch (err) {
      record("Valid installation webhook accepted + duplicate delivery idempotent", "FAIL", `network error: ${err.message}`);
    }
  }

  // --- summary ---
  console.log("\n--- Summary ---");
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const passed = results.filter((r) => r.status === "PASS");
  console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);

  if (failed.length > 0) {
    console.log("\nFAILED CHECKS:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verification script error:", err.message);
  process.exit(1);
});
