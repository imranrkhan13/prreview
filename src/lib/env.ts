import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  GITHUB_WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"),
  APP_MODE: optional("APP_MODE", "demo") as "demo" | "live",
  PORT: Number(optional("PORT", "3000")),
  DASHBOARD_ORIGIN: optional("DASHBOARD_ORIGIN", "http://localhost:5173"),
  PREVIEW_BASE_DOMAIN: optional("PREVIEW_BASE_DOMAIN", "localhost"),
  PREVIEW_PORT_RANGE_START: Number(optional("PREVIEW_PORT_RANGE_START", "4000")),
  PREVIEW_PORT_RANGE_END: Number(optional("PREVIEW_PORT_RANGE_END", "4999")),
  PREVIEW_TTL_HOURS: Number(optional("PREVIEW_TTL_HOURS", "24")),
  MAX_CONCURRENT_PREVIEWS_PER_ORG: Number(optional("MAX_CONCURRENT_PREVIEWS_PER_ORG", "5")),
  WORKER_POLL_INTERVAL_MS: Number(optional("WORKER_POLL_INTERVAL_MS", "2000")),
  REAPER_INTERVAL_MS: Number(optional("REAPER_INTERVAL_MS", "60000")),

  // --- Health check gate ---
  HEALTH_CHECK_TIMEOUT_MS: Number(optional("HEALTH_CHECK_TIMEOUT_MS", "60000")),
  HEALTH_CHECK_INTERVAL_MS: Number(optional("HEALTH_CHECK_INTERVAL_MS", "3000")),
  HEALTH_CHECK_MAX_ATTEMPTS: Number(optional("HEALTH_CHECK_MAX_ATTEMPTS", "20")),

  // --- Railway (real public-URL provider) ---
  // Only required if any repo has defaultProvider = RAILWAY. Left optional
  // at the env layer so LOCAL_DOCKER-only deployments don't need a Railway
  // account at all.
  RAILWAY_API_TOKEN: optional("RAILWAY_API_TOKEN", ""),
  RAILWAY_PROJECT_ID: optional("RAILWAY_PROJECT_ID", ""),
  RAILWAY_ENVIRONMENT_ID: optional("RAILWAY_ENVIRONMENT_ID", ""),

  // --- GitHub OAuth ("Sign in with GitHub") ---
  // Uses the GitHub App's own Client ID/Secret (Apps can act as OAuth
  // clients when "Request user authorization (OAuth) during installation"
  // is enabled in the App's settings) -- one App handles both login and
  // the installation/webhook flow. Required for the dashboard login flow;
  // NOT required just to run the webhook/worker/reaper processes, so it's
  // read lazily by the auth routes rather than validated at boot here.
  GITHUB_APP_CLIENT_ID: optional("GITHUB_APP_CLIENT_ID", ""),
  GITHUB_APP_CLIENT_SECRET: optional("GITHUB_APP_CLIENT_SECRET", ""),
  // Must exactly match a callback URL registered in the GitHub App's OAuth
  // settings. Points at the RAILWAY API, not the Vercel dashboard --
  // GitHub redirects here first, then this server redirects to the
  // dashboard with a one-time exchange code.
  GITHUB_OAUTH_CALLBACK_URL: optional("GITHUB_OAUTH_CALLBACK_URL", "http://localhost:3000/api/auth/github/callback"),

  // --- Session auth ---
  // Signs/verifies dashboard session tokens (src/lib/auth/session.ts) and
  // OAuth CSRF state params (src/lib/auth/oauthState.ts). Required in
  // "live" mode; falls back to an insecure dev-only default otherwise so
  // local development doesn't need to generate one, with a loud warning.
  SESSION_SECRET: optional("SESSION_SECRET", ""),
  SESSION_TTL_SECONDS: Number(optional("SESSION_TTL_SECONDS", String(60 * 60 * 24 * 7))), // 7 days
};

if (env.APP_MODE === "live" && !env.SESSION_SECRET) {
  throw new Error(
    "APP_MODE=live requires SESSION_SECRET to be set (a long random string) -- " +
      "dashboard sessions cannot be securely signed without it."
  );
}
if (env.APP_MODE !== "live" && !env.SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    "[env] SESSION_SECRET is not set -- using an insecure development-only " +
      "default. Sessions signed with this WILL be forgeable by anyone who reads " +
      "this source file. Set a real SESSION_SECRET before APP_MODE=live."
  );
}
export const resolvedSessionSecret = env.SESSION_SECRET || "insecure-dev-only-session-secret-do-not-use-in-production";

// Fail fast and loud if live mode is enabled without the credentials a real
// public provider needs. This enforces the product constraint: never
// silently claim a live, publicly-reachable deployment when it can't
// actually happen.
if (env.APP_MODE === "live" && !env.RAILWAY_API_TOKEN) {
  throw new Error(
    "APP_MODE=live requires RAILWAY_API_TOKEN (and RAILWAY_PROJECT_ID / " +
      "RAILWAY_ENVIRONMENT_ID) to be set — otherwise no repo can actually " +
      "produce a public deployment. Set APP_MODE=demo to run LOCAL_DOCKER-only."
  );
}
