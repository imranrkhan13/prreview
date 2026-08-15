# prpreview — PR preview environments for stateful apps

Connect a GitHub repository, and every pull request gets a shareable live
environment people can open and use before the PR is merged. Built for
apps that depend on databases, queues, or other backing services that
ordinary static-site preview deploys don't handle well.

**Status: MVP, partially verified.** See
[Final verification status](#final-verification-status) at the bottom for
exactly what has and hasn't been tested against real infrastructure —
this project is not called production-ready until that section says so.

---

## Architecture at a glance

```
GitHub PR event
   |  (HMAC-signed webhook, deduped by delivery ID)
   v
Fastify webhook route --> Postgres (Neon): PullRequest + Deployment(QUEUED)
   |  fork PR from an unapproved repo? -> needsApproval=true, stop here
   v
Worker (polling loop)
   |  QUEUED -> PROVISIONING -> DEPLOYING -> HEALTH_CHECK -> LIVE
   |                                              |
   |                                              +-> FAILED (timeout/error, with reason)
   |  LIVE -> UPDATING -> HEALTH_CHECK -> LIVE   (new commit - same gate, no shortcuts)
   |  * -> STOPPED (PR closed/merged)
   v
DeploymentProvider interface
   +- LocalDockerProvider   (real; localhost-only; for local trial)
   +- RailwayProvider       (real; public URL; unverified against live API - see below)
   v
Reaper (cron loop) --> expires LIVE deployments past TTL --> STOPPED/EXPIRED
   v
Dashboard (React) --> reads Postgres only --> URL is only ever shown once
                       the deployment record reached LIVE, i.e. passed
                       its health check. A provider creating a service is
                       never sufficient by itself.
```

The health-check gate is the core truthfulness mechanism: `provider.provision()`
returning a URL does NOT mark anything LIVE. The worker polls that URL
(`src/lib/healthCheck.ts`) until it actually responds or the check times
out; only a passing health check can move a deployment into `LIVE`, and
that's enforced structurally by the state machine (`HEALTH_CHECK` can only
go to `LIVE` or `FAILED`, never anywhere else).

## Authentication architecture

The dashboard requires GitHub sign-in. The generated preview URLs do not
require any prpreview account — that distinction is deliberate and
enforced structurally, not just by convention:

```
Browser                         Railway API                      Neon
   |  click "Continue with GitHub"  |                                |
   |-------------------------------->|                                |
   |         redirect to github.com/login/oauth/authorize            |
   |  (with a signed, short-lived `state` param -- CSRF protection)   |
   |                                 |                                |
   |  <-- GitHub redirects back to /api/auth/github/callback -->      |
   |                                 |  exchange code for GH token     |
   |                                 |  fetch GH user profile          |
   |                                 |  upsert User row --------------->|
   |                                 |  create one-time exchange code ->|
   |  <-- redirect to VERCELORIGIN/auth/callback?code=... --           |
   |                                 |                                |
   |  POST /api/auth/exchange {code}|                                |
   |-------------------------------->|  consume one-time code (single-use, 60s TTL) |
   |                                 |  mint signed session token ---->|
   |  <-- { token, expiresAt } ------|                                |
   |  store token in sessionStorage (tab-scoped, never localStorage)  |
   |                                 |                                |
   |  every /api/* request: Authorization: Bearer <token>              |
   |-------------------------------->|  verify signature + expiry      |
   |                                 |  check RevokedSession (logout)  |
   |                                 |  resolve Membership -> orgIds -->|
   |                                 |  scope EVERY query to those ids  |
```

**Why a signed bearer token instead of a cookie**: the dashboard (Vercel)
and API (Railway) are different origins. A cookie-based session would need
`SameSite=None; Secure` plus `credentials: 'include'` on every request and
still runs into browsers' increasingly aggressive third-party-cookie
restrictions. A bearer token sent explicitly in an `Authorization` header
sidesteps all of that, at the cost of needing to store it client-side
(sessionStorage, tab-scoped, cleared on tab close -- not localStorage).

**Why a one-time exchange code instead of putting the session token
directly in the OAuth redirect URL**: URLs end up in browser history,
server access logs, and `Referer` headers. The redirect only ever carries
a random, single-use, 60-second-lived code; the real session token is
only ever transmitted via a POST body over HTTPS.

**Session tokens are stateless and HMAC-signed** (`src/lib/auth/session.ts`)
-- verifying one is a signature check plus an expiry check, no DB round
trip needed for the common case. The ONE piece of server state that
exists is `RevokedSession`, checked on every request specifically so
"Sign out" actually invalidates that session immediately, rather than
just discarding the client's copy of a token that would otherwise remain
valid until its own expiry.

**Multi-tenancy**: a `User` can have `Membership` rows in multiple
`Organization`s (e.g. they installed the GitHub App for their personal
account and also belong to a company org). Every authorization check
resolves `request.auth.authorizedOrgIds` from the database via
`Membership` -- **never** from an `orgId`/`userId`/`repoId` the client
supplies. See `src/lib/auth/resolveAuth.ts` and its test suite for the
exact boundary this enforces, including the case of a session and an API
key both being present (session wins).

**Automation/API keys remain available** (`X-API-Key`, `prpk_...`) as a
secondary auth path for scripts and testing -- `resolveAuth` tries session
auth first and falls back to API-key auth only if no `Authorization`
header is present. This is intentionally not the primary dashboard
mechanism anymore.

---

## Repo layout

```
src/
  server/           Fastify app: webhook route, dashboard API, access control
  worker/           Polling worker: provision / redeploy / teardown
  reaper/           TTL expiration sweep
  providers/        DeploymentProvider interface + LocalDockerProvider + RailwayProvider
  lib/
    env.ts                   boot-time env loading/validation
    prisma.ts                Prisma client singleton
    stateMachine.ts          explicit deployment states + legal transitions
    healthCheck.ts           the LIVE-gating HTTP poll
    killSwitch.ts            live-read emergency stop, no restart needed
    verifyWebhookSignature.ts   HMAC verification
    approvalDecision.ts      fork-approval authorization (pure, testable)
    railwayClient.ts         Railway GraphQL transport (injectable fetch)
    railwayRequests.ts       Railway request/response builders (pure, testable)
    auth/
      session.ts             signed session tokens
      oauthState.ts          signed OAuth CSRF state param
      githubOAuthClient.ts   GitHub OAuth transport (injectable fetch)
      githubOAuthRequests.ts GitHub OAuth request/response builders (pure, testable)
      resolveAuth.ts         dual-mode (session + API key) authorization boundary
      apiKey.ts              API key hashing
prisma/schema.prisma    Data model
web/                    React + Vite dashboard
scripts/                Local demo/seed scripts
examples/sample-target-repo/.prpreview/Dockerfile   What a target repo provides
```

## Repo requirements (for repos you want previews of)

Any repository you enable previews for must include a
`.prpreview/Dockerfile` at its root that builds the app and listens on
port `3000` inside the container. See
`examples/sample-target-repo/.prpreview/Dockerfile` for a working example.

---

## Setup

Run each block as its own step - don't paste the whole page at once, since
several steps need you to fill in a real value before continuing.

**1. Extract the archive**

```bash
tar -xzf prpreview-mvp.tar.gz
```

```bash
cd prpreview
```

**2. Install dependencies**

```bash
npm install
```

**3. Create your `.env`**

```bash
cp .env.example .env
```

**4. Set the required variables**

Open `.env` and fill in at minimum:

```bash
DATABASE_URL="postgresql://user:password@ep-xxxx.neon.tech/prpreview?sslmode=require"
GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

If you want real public preview URLs (not just local Docker), also set:

```bash
RAILWAY_API_TOKEN="your-railway-token"
RAILWAY_PROJECT_ID="your-railway-project-id"
RAILWAY_ENVIRONMENT_ID="your-railway-environment-id"
```

For dashboard login (GitHub OAuth) -- see
[GitHub App / webhook setup](#github-app--webhook-setup) for where to get
these:

```bash
GITHUB_APP_CLIENT_ID="your-github-app-client-id"
GITHUB_APP_CLIENT_SECRET="your-github-app-client-secret"
GITHUB_OAUTH_CALLBACK_URL="http://localhost:3000/api/auth/github/callback"
SESSION_SECRET="$(openssl rand -hex 32)"
```

**5. Run the Prisma migration and generate the client**

```bash
npx prisma migrate dev --name init
```

```bash
npx prisma generate
```

**6. Seed a demo organization, repository, and user**

```bash
npx tsx scripts/seed-demo-org.ts
```

This prints an automation API key AND a ready-to-use dashboard session
token, once each. The session token lets you open the dashboard
immediately without a real GitHub OAuth round-trip during local
development.

**7. Start the server, worker, and reaper** (three separate terminals)

```bash
npm run dev:server
```

```bash
npm run dev:worker
```

```bash
npm run dev:reaper
```

**8. Start the dashboard** (a fourth terminal)

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:5173`. For local dev, open DevTools -> Application
-> Session Storage -> `http://localhost:5173`, add a key
`prpreview_session_token` with the value printed in step 6, and reload --
this skips real GitHub OAuth for local testing. In a real deployment, you'd
instead click **Continue with GitHub** on the landing page.

**9. Connect a repository**

For the demo org, `seed-demo-org.ts` already inserted one `Repository` row
with `allowed: true`. For a real repo, follow
[GitHub App / webhook setup](#github-app--webhook-setup) below, then
insert (or build a small admin script to insert) a matching `Repository`
row with `allowed: true` and the `defaultProvider` you want.

**10. Run your first real PR test**

Open a real pull request against a connected repository (or use the
[demo script](#demo-script) to simulate one locally without GitHub).
Watch the dashboard: the PR should appear, move through
`QUEUED -> PROVISIONING -> DEPLOYING -> HEALTH_CHECK -> LIVE`, and the
shareable URL should appear only once it reaches `LIVE`.

**11. Clean up Railway resources when you're done experimenting**

```bash
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: cleanup-1" \
  -d '{"action":"closed","number":42,"pull_request":{"merged":true}}'
```

or close the real PR on GitHub - either way the worker calls
`provider.teardown()`, which deletes the Railway service. You can also
check the Railway dashboard directly to confirm nothing was left running,
and set `KILL_SWITCH=true` in `.env` (no restart needed, the worker reads
it live) if you need to stop all new provisioning immediately.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon/Postgres connection string |
| `GITHUB_WEBHOOK_SECRET` | yes | Verifies `X-Hub-Signature-256` on every webhook |
| `APP_MODE` | no (default `demo`) | `live` requires Railway credentials to be set - see `src/lib/env.ts` |
| `PORT` | no (default `3000`) | Fastify server port |
| `DASHBOARD_ORIGIN` | no | CORS origin allowed to call the dashboard API |
| `PREVIEW_BASE_DOMAIN` | no (default `localhost`) | Host used in LocalDockerProvider URLs |
| `PREVIEW_PORT_RANGE_START` / `_END` | no | Host port range for local preview containers |
| `PREVIEW_TTL_HOURS` | no (default `24`) | How long a LIVE deployment lives before the reaper stops it |
| `MAX_CONCURRENT_PREVIEWS_PER_ORG` | no (default `5`) | Cost/DoS control |
| `WORKER_POLL_INTERVAL_MS` / `REAPER_INTERVAL_MS` | no | Polling cadence |
| `HEALTH_CHECK_TIMEOUT_MS` | no (default `60000`) | How long to wait for a deployment to become reachable before marking FAILED |
| `HEALTH_CHECK_INTERVAL_MS` | no (default `3000`) | Delay between health-check poll attempts |
| `KILL_SWITCH` | no (default `false`) | Set `true` to stop all new provisioning immediately - read live every worker tick, no restart needed |
| `RAILWAY_API_TOKEN` | only for `RAILWAY` provider | Server-side only - never returned by any API response or shown in the dashboard |
| `RAILWAY_PROJECT_ID` / `RAILWAY_ENVIRONMENT_ID` | only for `RAILWAY` provider | From your Railway project settings |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | yes, for dashboard login | From the GitHub App's settings page, "OAuth" section -- see [GitHub App / webhook setup](#github-app--webhook-setup) |
| `GITHUB_OAUTH_CALLBACK_URL` | yes, for dashboard login | Must exactly match a callback URL registered in the GitHub App's OAuth settings, e.g. `https://RAILWAYAPIURL/api/auth/github/callback` |
| `SESSION_SECRET` | yes in `APP_MODE=live` | Long random string signing dashboard session tokens and OAuth CSRF state. Server refuses to boot in live mode without it |
| `SESSION_TTL_SECONDS` | no (default `604800`, 7 days) | How long a dashboard session stays valid before requiring re-login |

No production secrets belong in `.env` for preview purposes - see
[Secrets and isolation](#secrets-and-isolation) below for how the per-repo
allowlist works.

---

## Demo vs. public mode

Each connected repository picks its own `defaultProvider`:

- **`LOCAL_DOCKER`** (default) - runs in a container on the operator's own
  machine. URL is `http://localhost:<port>`, reachable only locally.
- **`RAILWAY`** - deploys to Railway and produces a real
  `https://<slug>.up.railway.app` URL, reachable by anyone on the
  internet, once the health check passes.

**Scope stays narrow in both modes**: only repos an org owner explicitly
connects and marks `allowed = true` ever get previews - this does not
support pointing prpreview at arbitrary strangers' repositories.

---

## Fork safety

Within a connected repo:
- PRs from the **same repository's branches** deploy automatically (only
  collaborators can push to them).
- PRs from **forks** are held with `needsApproval = true` and never
  auto-deploy, unless the repo owner has explicitly set
  `allowForkPrs = true`.
- Approving a fork PR requires a `POST /api/prs/:prId/approve` call with a
  valid org API key. The authorization decision
  (`src/lib/approvalDecision.ts`) is re-derived from the database on every
  request - org ownership, current `needsApproval` state, and whether a
  deployment is already active are all read fresh, never trusted from
  anything the client asserts. A request for a PR that doesn't resolve
  inside the caller's own org gets a 404, identical to "doesn't exist" -
  it doesn't leak which case it is. A duplicate approval attempt (a
  deployment already active) gets a 409, not a second deployment.
- See `src/lib/approvalDecision.test.ts` for the authorization test cases:
  allowed, unauthorized org, already-approved, and duplicate/already-active.

---

## Recovering from a failed baseline migration

If `prisma:deploy` fails with something like `P3018: type "X" already
exists`, that means the target database already has schema objects from
before migrations were adopted (e.g. it was previously synced with
`prisma db push`), and the one-time baseline resolution step wasn't run
first. Recovery, in order — **back up before step 1**:

```bash
# 1. Back up first (Neon: create a branch from the current point, or:)
pg_dump "$DATABASE_URL" > backup-before-migration-fix.sql
```

```bash
# 2. Clear the failed migration record (does not touch your tables --
#    only tells Prisma "that attempt did not succeed")
npx prisma migrate resolve --rolled-back 0_baseline
```

```bash
# 3. Confirm the live schema actually matches prisma/schema.prisma --
#    don't assume. This prints the SQL that WOULD be needed to reconcile
#    them; empty/no-op output means they already match.
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

```bash
# 4. Only if step 3 came back clean, mark the baseline as applied
#    WITHOUT re-running its SQL
npx prisma migrate resolve --applied 0_baseline
```

```bash
# 5. Confirm clean state -- expect "Database schema is up to date!"
npx prisma migrate status
```

After this, redeploy normally — `prisma:deploy` will see `0_baseline`
already applied and skip it.

---

## Production verification tooling

Two scripts exist for verifying a *deployed* instance, as distinct from
`npm test` (which only exercises code-level logic against nothing real):

### `scripts/check-migration-baseline.js`

Runs automatically as part of `npm run prisma:deploy` (wired into
`package.json`), before `prisma migrate deploy` itself. Detects a failed
or drifted migration state and **blocks the deploy with instructions**
rather than letting a cryptic Postgres error stop the container — this is
the direct fix for the incident described above. It never attempts to
resolve anything automatically; that always requires a human to confirm
the live schema first (see the recovery steps above).

### `scripts/verify-production.js`

Verifies a live, deployed instance from the outside — real HTTP requests
against the real Railway API and, for CORS, the real Vercel origin. Every
value comes from an environment variable; nothing is hardcoded, and
missing optional variables SKIP that specific check with a clear reason
rather than failing or fabricating a result. It was smoke-tested in this
session against two local mock servers: a correctly-behaving one (all
checks passed) and a deliberately broken one with an auth bypass,
cross-org data leak, permissive CORS, and forged-signature acceptance
injected — the script correctly flagged all four as FAIL while still
passing the two things that were genuinely fine. That's evidence the
script's logic works; it has NOT been run against your actual live
Railway/Vercel/Neon deployment (no credentials or network access to them
from this environment).

```bash
RAILWAY_API_URL="https://RAILWAYAPIURL" \
VERCEL_ORIGIN="https://VERCELORIGIN" \
TEST_API_KEY="TESTAPIKEY" \
node scripts/verify-production.js
```

Checks performed: `GET /health`, `GET /ready`, unauthenticated request
returns 401, authenticated request succeeds, CORS preflight allows the
production Vercel origin, CORS does not allow an unapproved origin, and a
malformed webhook signature is rejected with 401.

Checks that SKIP unless additional env vars are provided (each documented
in the script's header comment): cross-org access denial (needs
`TEST_API_KEY_ORG_B` + `TEST_REPO_ID`), and a validly-signed installation
webhook being accepted plus a duplicate delivery being idempotent (needs
`GITHUB_WEBHOOK_SECRET` + `TEST_INSTALLATION_PAYLOAD`).

The script never prints a secret value, key, or webhook payload — only
pass/fail/skip and short diagnostic messages (status codes, header
values, counts).

---

## Health-gated public URLs

A deployment is never shown as live because a provider created a service
or container - that only proves infrastructure exists, not that the app
works. The gate:

1. `provider.provision()` returns a URL (Railway: after `serviceDomainCreate`;
   LocalDocker: after the container starts).
2. The worker transitions to `HEALTH_CHECK` and polls that URL
   (`src/lib/healthCheck.ts`) every `HEALTH_CHECK_INTERVAL_MS` until it
   gets any HTTP response or `HEALTH_CHECK_TIMEOUT_MS` elapses.
3. Only a real response moves the deployment to `LIVE` - and only then is
   the URL persisted to the deployment record and shown in the dashboard.
4. A timeout moves it to `FAILED` with a concrete reason. The state
   machine physically cannot go `HEALTH_CHECK -> LIVE` without passing
   through this code path - see `src/lib/stateMachine.ts`.
5. **Redeploys go through the identical gate.** A new commit never
   replaces a working LIVE deployment's shown status until the new
   version also passes health - status sits in `HEALTH_CHECK`, not `LIVE`,
   during that window, so an old deployment is never left falsely marked
   live while a broken new commit sits behind that URL.

---

## Secrets and isolation

- **Per-repo secret allowlist, empty by default**: `Repository.secretAllowlist`
  is a list of env var *names*. The worker resolves each name from the
  **operator's own `process.env`** (never a shared prod secret store, never
  a value the client supplies) and injects only those into the preview.
  A repo with an empty allowlist (the default) gets zero secrets beyond
  `PREVIEW=true` and `PR_NUMBER`.
- **No production database/network access**: nothing in this codebase
  wires a preview to a production database or internal network - that
  would have to be something a repo owner deliberately does via the
  allowlist, and doing so is on them, not something this system sets up
  for you.
- **Isolation caveat - read this before trusting it with untrusted code**:
  both providers run preview code in a standard container
  (`LocalDockerProvider`: Docker on the operator's machine;
  `RailwayProvider`: Railway's own container infrastructure). **This is
  ordinary container isolation, not a hardened microVM sandbox
  (Firecracker) or a syscall-filtering sandbox (gVisor).** Do not connect
  a repository whose PRs might contain code you wouldn't trust to run in
  a normal Docker container on shared infrastructure. This is why fork
  PRs require manual approval by default - a human is the isolation
  boundary here, not the container.
- **Preview URL sensitivity**: preview URLs are public by default once
  `LIVE` (Railway `.up.railway.app` domains are guessable-but-not-listed,
  not access-controlled). `Repository.previewAuthRequired` exists as a
  schema flag to mark a repo's previews as sensitive, but **no enforcement
  is implemented yet** - there's no auth proxy in front of preview URLs.
  Treat this as a documented gap: don't connect a repo with sensitive data
  in its previews until an access-token/auth layer is actually built.
- **Resource limits**: `LocalDockerProvider` caps each container at 512MB
  RAM / 1 vCPU. `MAX_CONCURRENT_PREVIEWS_PER_ORG` (default 5) caps
  concurrent deployments per org. `PREVIEW_TTL_HOURS` (default 24) auto-expires
  abandoned previews. `KILL_SWITCH=true` stops all new provisioning
  immediately, read live every worker tick.
- **Webhook rate limiting**: the Fastify app has a global rate limit
  (100 requests/minute) via `@fastify/rate-limit`, which also covers the
  webhook endpoint as backpressure against a delivery flood.

---

## GitHub App / webhook setup

One GitHub App handles both the webhook/installation flow AND "Sign in
with GitHub" (via the App's own OAuth capability) -- you don't need a
separate OAuth App.

1. Create a GitHub App: **Settings -> Developer settings -> GitHub Apps -> New GitHub App**.
2. **Webhook URL**: `https://RAILWAYAPIURL/webhooks/github` (use `ngrok http 3000`
   for local testing).
3. **Webhook secret**: generate a long random string, put it in both the
   GitHub App settings and `.env` as `GITHUB_WEBHOOK_SECRET`.
4. Subscribe to these events:
   - **Pull request** (covers `opened`, `synchronize`, `reopened`, `closed`)
   - **Installation** (covers `created`, `deleted`, `suspend`, `unsuspend`)
   - **Installation repositories** (covers `added`, `removed`)
5. **Permissions**: **Pull requests: Read-only**, **Contents: Read-only**
   (needed to clone the PR's commit for the Docker build), **Metadata: Read-only** (required by GitHub for any App).
6. **OAuth (for dashboard login)**: in the App's settings, under
   "Identifying and authorizing users", check **"Request user
   authorization (OAuth) during installation"**. Set the **Callback URL**
   to `https://RAILWAYAPIURL/api/auth/github/callback` -- must exactly
   match `GITHUB_OAUTH_CALLBACK_URL` in `.env`. Copy the **Client ID** and
   generate a **Client secret**; these become `GITHUB_APP_CLIENT_ID` and
   `GITHUB_APP_CLIENT_SECRET`.
7. Install the App on the account/org whose repos you want to preview.
   This is what triggers the `installation` webhook, which:
   - Creates the `Organization` row (keyed by GitHub's numeric org/account
     id, never the name).
   - Creates/links a `User` + `Membership` (role `OWNER`) for whoever
     performed the install (`payload.sender`), so their next GitHub OAuth
     login resolves to this org automatically -- no manual linking step.
   - Syncs each accessible repo as a `Repository` row with
     `allowed: false` -- previews are never auto-enabled just because the
     App can see a repo. Enable each one explicitly in the dashboard.
   - Also logs a one-time automation API key for that org (for
     `scripts/verify-production.js` and similar, not for normal dashboard
     use).
8. Confirm GitHub's **Advanced -> Recent Deliveries** tab shows a
   successful (green, 200) delivery for the installation webhook.

---

## Demo script

Simulates the full opened -> live -> updated -> stopped lifecycle without a
real GitHub App, using `curl` against the webhook endpoint directly.

**1. Get your webhook secret and the seeded repo's GitHub id**

```bash
grep GITHUB_WEBHOOK_SECRET .env
```

(the seed script prints the demo repo's `githubRepoId` when it runs - use
that value below)

**2. Simulate a PR opened event**

```bash
SECRET="paste-your-secret-here"
BODY='{"action":"opened","number":42,"pull_request":{"title":"Add checkout flow","merged":false,"head":{"sha":"abc123def456","repo":{"fork":false}},"base":{"sha":"main000000"},"user":{"login":"imran"}},"repository":{"id":REPLACE_WITH_SEEDED_GITHUB_REPO_ID,"full_name":"demo-org/sample-app"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* /sha256=/')
```

```bash
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: demo-delivery-1" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

Watch the dashboard: PR #42 appears, status moves
`QUEUED -> PROVISIONING -> DEPLOYING -> HEALTH_CHECK -> LIVE`. The URL only
appears once `LIVE` - that's the health check having actually passed.

**3. Simulate a new commit (triggers redeploy)**

Repeat step 2 with `"action":"synchronize"` and a new `head.sha` and a new
`X-GitHub-Delivery` value. Dashboard shows
`LIVE -> UPDATING -> HEALTH_CHECK -> LIVE` with the new commit SHA - never
a direct jump back to LIVE.

**4. Simulate PR closed (triggers teardown)**

Repeat with `"action":"closed"` and `"merged":true` (or `false`). Dashboard
shows `LIVE -> STOPPED`; the container/service is torn down.

**5. Simulate a duplicate delivery (idempotency check)**

Resend the exact same request from step 2 with the same
`X-GitHub-Delivery` header. The response should be
`{"status":"duplicate_ignored"}` and no second deployment should appear.

---

## Fork approval demo

```bash
BODY='{"action":"opened","number":99,"pull_request":{"title":"External contribution","merged":false,"head":{"sha":"fork123","repo":{"fork":true}},"base":{"sha":"main000000"},"user":{"login":"outside-contributor"}},"repository":{"id":REPLACE_WITH_SEEDED_GITHUB_REPO_ID,"full_name":"demo-org/sample-app"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* /sha256=/')
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: fork-demo-1" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
```

Dashboard shows PR #99 with a **"Needs approval"** badge and no
deployment. Click into it, click **Approve and deploy preview** - only
then does a `QUEUED` deployment appear and the normal lifecycle begins.

---

## What's production-ready vs. prototype

**Production-ready patterns:**
- Webhook signature verification (timing-safe HMAC)
- Webhook idempotency (unique delivery ID constraint)
- Explicit deployment state machine with illegal-transition guards,
  including the health-check gate that structurally prevents skipping to LIVE
- Provider abstraction boundary (`DeploymentProvider` interface)
- Org-scoped data access on every dashboard API route
- Fork-PR approval re-derived server-side from the database on every request
- Per-repo secret allowlist, empty by default
- Kill switch, read live every worker tick

**Prototype-level, needs work before real usage:**
- `RailwayProvider`'s request/response shapes are corroborated by Railway's
  published docs but have never been sent to the live API from this
  environment - see [Final verification status](#final-verification-status).
- `RailwayProvider.getLogs()` is a documented stub - real log streaming
  needs a GraphQL-over-WebSocket subscription client, not built yet.
- Preview URL access control (`previewAuthRequired`) is a schema field
  with no enforcement yet.
- Fork-PR approval has no notification (email/Slack) - an admin has to
  check the dashboard.
- Dashboard access control is GitHub OAuth + Membership-based multi-org
  authorization (role stored per-membership: OWNER/ADMIN/MEMBER), but role
  is not yet ENFORCED differently per action -- any member can currently
  do anything a dashboard route allows for their org. Real RBAC
  (e.g. only OWNER can disable a repo) is not yet implemented.
- Worker is a single-process polling loop - not horizontally scalable or
  crash-safe (no job leasing).
- GitHub App installation flow is manual (`seed-demo-org.ts`), not wired
  to the real `installation` webhook event.
- No billing, no multi-region, no build caching beyond Docker's own layer cache.

---

## Tests

Run with `npm test`. 52 tests across 7 files, all passing as of this
writing (see [Final verification status](#final-verification-status) for
the exact command output).

| File | Covers |
|---|---|
| `verifyWebhookSignature.test.ts` | valid/invalid/tampered/missing signature, string vs Buffer bodies |
| `stateMachine.test.ts` | full happy path including `DEPLOYING`/`HEALTH_CHECK`, retry-from-FAILED, TTL expiration, rejection of illegal transitions (including skipping the health check on both first provision and redeploy) |
| `healthCheck.test.ts` | immediate success, non-2xx-still-healthy, retry-then-succeed, timeout-with-reason, custom health check path |
| `railwayRequests.test.ts` | fixture-based request/response shape tests for every Railway mutation used (`serviceCreate`, `serviceInstanceDeployV2`, `serviceDomainCreate`, `serviceDelete`, domain lookup) - this is the "integration-test seam" substituting for live API access |
| `railwayClient.test.ts` | transport-layer tests via injected mock fetch: auth header, success, GraphQL-level errors, HTTP errors, missing token, network failure |
| `RailwayProvider.test.ts` | full provider-level flow (provision/update/teardown) via injected mock fetch, including the exact-commit-SHA assertion |
| `approvalDecision.test.ts` | fork-gating computation, and approval authorization: allowed, unauthorized org (404), not-pending (400), duplicate/already-active (409) |

**Known gap, not hidden**: nothing above touches a live Postgres, live
Docker socket, or live Railway API - those require actual infrastructure
this sandbox doesn't have network access to. The manual demo scripts above
are the closest substitute; see the next section for exactly what that
means for production-readiness.

---


## Migration strategy

**Incident record, kept intentionally instead of scrubbed:** on first real
Railway deploy, `prisma migrate deploy` failed with `P3018: type "Role"
already exists`, because the live Neon database had been synced with
`prisma db push` and the one-time `prisma migrate resolve --applied
0_baseline` step below was never run before this automated deploy fired.
Prisma runs each migration file as a single transaction on Postgres, so
the failure on statement 1 rolled back cleanly — no schema damage — but it
left a `failed` row in `_prisma_migrations` that blocks all future
`migrate deploy` runs until resolved by hand. `scripts/check-migration-baseline.js`
(see below) now runs before every `prisma:deploy` specifically to catch
this class of failure with actionable instructions instead of a bare
Postgres error code.

This project's Neon database was previously synchronized with
`npx prisma db push` — a schema-drift tool with no migration history. This
repo now includes a proper baseline migration
(`prisma/migrations/0_baseline/migration.sql`), hand-authored to exactly
match `prisma/schema.prisma` (not generated against a live database in
this sandbox — see [Final verification status](#final-verification-status)).

**If your database was already synced via `db push` (this project's was):**
do NOT run the baseline migration's SQL against it — the tables already
exist and `CREATE TABLE` would fail. Instead, tell Prisma the migration is
already applied without running it:

```bash
npx prisma migrate resolve --applied 0_baseline
```

Then verify the migration table agrees with reality:

```bash
npx prisma migrate status
```

From this point on, use `prisma migrate dev` (locally) to create every new
migration, and `prisma migrate deploy` (via `npm run prisma:deploy`) in
Railway's pre-deploy step — never `db push` again, since `db push` doesn't
write migration history and will drift out of sync with this baseline.

**If you're setting up a brand-new database** (not this project's existing
Neon instance), skip the `resolve --applied` step and just run:

```bash
npx prisma migrate deploy
```

which applies `0_baseline` (and anything after it) normally, since there's
no existing schema to conflict with.

**Railway pre-deploy command**: set the API service's pre-deploy (or
release) command to:

```bash
npm run prisma:deploy
```

which runs `prisma migrate deploy` — safe to run on every deploy, since it
only applies migrations that haven't been applied yet.

---
## Controlled beta launch checklist

Per the standard set earlier in this project: the first public release
should be **READY WITH LIMITATIONS**, launched as a controlled beta with
one or two test teams — not an open signup, not "any repo for anyone."
This section states exactly what that means concretely.

### Scope: what's actually supported at launch

- **Repository connection**: explicit opt-in only. An org owner installs
  the GitHub App and clicks "Enable previews" per repo in the dashboard.
  There is no self-serve flow for a stranger to point prpreview at a repo
  they don't own or administer — that was a deliberate scope decision
  (see "Demo vs. public mode" above), not a missing feature.
- **Build requirement**: the target repo must provide a
  `.prpreview/Dockerfile` at its root, listening on port 3000. Repos
  without one will queue a deployment that fails with a clear reason
  ("No .prpreview/Dockerfile found"), not a silent no-op.
- **Runtime**: whatever the repo's own Dockerfile installs — prpreview
  itself has no runtime restrictions beyond "must build and run in a
  standard Docker container." No buildpack auto-detection.
- **Secrets**: none flow into a preview unless the repo owner explicitly
  lists the env var *names* in that repo's `secretAllowlist`, and even
  then only values already present in the operator's own Railway
  environment are injected. No secrets vault, no per-preview secret
  upload UI yet.
- **Deployment provider**: Railway only, for real public URLs
  (`https://<slug>.up.railway.app`). Vercel/Render/Fly.io/Kubernetes
  remain typed stubs, not implemented.
- **Fork PRs**: never auto-deploy. Held for manual approval by a repo
  admin regardless of provider — this is a hard rule, not a per-repo
  toggle that can be silently disabled by default.
- **Access control**: GitHub OAuth sign-in, multi-org via Membership. Role
  (OWNER/ADMIN/MEMBER) is stored but not yet enforced per-action -- any
  member of an org can currently do anything the dashboard allows for that
  org. Fine for a small beta team you trust; not fine for a large org
  needing granular permissions yet.

### Beta guardrails already in place — confirm these are set correctly before inviting anyone

| Setting | Recommended beta value | Why |
|---|---|---|
| `MAX_CONCURRENT_PREVIEWS_PER_ORG` | 3-5 | Caps cost exposure per test team |
| `PREVIEW_TTL_HOURS` | 12-24 | Abandoned previews don't run indefinitely |
| `KILL_SWITCH` | `false` (but know how to flip it) | Emergency stop, read live every worker tick, no restart needed |
| `DEPLOYMENTS_ENABLED` | `true` | Normal on/off; flip `false` for a controlled pause without touching `KILL_SWITCH` |
| `HEALTH_CHECK_TIMEOUT_MS` / `HEALTH_CHECK_MAX_ATTEMPTS` | defaults (60s / 20) | Tune only after watching real build times for your beta repos |

### Rollout steps for the first 1-2 teams

1. Confirm [Final verification status](#final-verification-status) below
   is fully green — do not invite anyone before that.
2. Have each beta team's admin install the GitHub App on their account/org
   themselves (this creates their `Organization` + links their GitHub
   identity via `Membership` automatically), then have them sign in to
   the dashboard with "Continue with GitHub" — no API key to hand out or
   manage for normal dashboard use.
3. Walk one real PR through the full lifecycle together, watching the
   dashboard and Railway logs live, before leaving them unattended.
4. Watch Railway logs and the dashboard's deployment events for the first
   several real PRs from each team. Look specifically for: deployments
   stuck in a non-terminal state, unexpected FAILED reasons, and health
   checks passing slower or slower-timing-out than `HEALTH_CHECK_TIMEOUT_MS`
   expects.
5. Only after that goes cleanly, consider inviting additional teams — one
   at a time, not a batch.

### What "public" means here, precisely

This is a controlled beta for **teams you've personally onboarded**, using
real public preview URLs (once Railway mode is confirmed working end to
end). It is explicitly NOT: a self-serve product anyone can sign up for,
support for arbitrary public GitHub repos without an owner's explicit
opt-in, or a claim that every repo/framework/runtime is supported. If you
want to expand scope to open signup or arbitrary-repo support later,
that's a real product and security decision — flag it explicitly when
you're ready for that conversation, since it changes the threat model
discussed earlier in this project (untrusted code execution, cost
exposure, abuse).

---

## Security model

This section maps the security audit requested when this became a public
multi-tenant product to what's actually true in the codebase today, item
by item -- not a generic checklist, an honest accounting.

| Concern | Status |
|---|---|
| Command injection | Mitigated: `buildCheckout.ts` uses `execFile` with argument arrays (never a shell string) for `git`/`docker` calls; commit SHAs and repo full names are pattern-validated (`repoFullName.ts`) before use. |
| Path traversal | Mitigated: the only filesystem paths built from external input are the commit-SHA-validated git checkout dir (via `mkdtemp`, a random dir, not user-controlled) and a fixed literal `.prpreview/Dockerfile` join. |
| Malicious Dockerfiles | **NOT mitigated beyond standard container isolation.** A repo's `.prpreview/Dockerfile` runs as a normal Docker build with normal Docker capabilities. See "Isolation caveat" below -- this is the single biggest real limitation of the product as built. |
| SSRF | Health checks (`healthCheck.ts`) only ever fetch a URL the provider itself just returned (Railway's own generated domain, or a `localhost` port prpreview allocated) -- never an arbitrary client- or repo-supplied URL. |
| Webhook replay | Mitigated: `webhook_deliveries` unique constraint on GitHub's delivery ID makes a replayed/duplicate delivery a no-op. Does not protect against GitHub itself being compromised and re-signing a new payload -- out of scope, that's GitHub's security boundary. |
| GitHub installation spoofing | Mitigated: HMAC signature verification on every webhook (timing-safe compare) plus org/repo identity keyed on GitHub's numeric IDs, never names. |
| Repository spoofing | Mitigated: same numeric-ID keying; `repoFullName.ts` validation as defense in depth before that name is used to build a clone URL or Railway source config. |
| Cross-tenant access | Mitigated: every dashboard query filters by `authorizedOrgIds` derived from `Membership`, never a client-supplied `orgId`. Covered by `resolveAuth.test.ts` and `accessControl.test.ts`. NOT covered by a live HTTP integration test against the running Fastify app -- see "Final verification status". |
| Secret leakage (API responses) | Mitigated: grepped to confirm `RAILWAY_API_TOKEN`, `GITHUB_APP_CLIENT_SECRET`, `SESSION_SECRET`, and the GitHub user's OAuth access token never appear in any route response or React component. |
| Logs leaking credentials | Mitigated: pino `redact` covers `Authorization`, `X-API-Key`, and the webhook signature header; the GitHub OAuth access token is a local variable, never logged. |
| Unsafe environment variable injection into previews | Mitigated: `resolveAllowedEnv` in the worker only pulls keys explicitly listed in a repo's `secretAllowlist`, resolved from the **operator's** `process.env` -- never a value the webhook payload or a client request supplies. |
| Arbitrary Railway project manipulation | Mitigated by design: `RAILWAY_API_TOKEN` never reaches a preview container (it's a control-plane-only credential, read by `RailwayProvider` server-side); the allowlist mechanism above is the only way env vars reach a preview. |
| Deployment resource exhaustion | Partially mitigated: `MAX_CONCURRENT_PREVIEWS_PER_ORG`, `PREVIEW_TTL_HOURS`, `KILL_SWITCH`, `DEPLOYMENTS_ENABLED`, and `LocalDockerProvider`'s per-container 512MB/1vCPU caps all exist. Railway-side resource limits per service are NOT configured by this codebase -- that's a Railway project setting to set yourself. |

**Isolation caveat, repeated because it matters most**: both providers run
preview code in standard container isolation (Docker locally, Railway's
own container infra in production) -- **not** a hardened microVM sandbox
(Firecracker) or syscall-filtering sandbox (gVisor). This is why fork PRs
require manual human approval by default: a human reviewing the diff is
the actual isolation boundary for untrusted code today, not the container.
Do not connect a repository whose PRs might contain code you wouldn't
trust to run in a normal Docker container on shared infrastructure.

---

## Troubleshooting

**"Prisma CLI Version" doesn't match what's in package.json (e.g. reports
7.x when package.json pins `^5.20.0`)**: `node_modules` wasn't installed
in this exact directory, so `npx prisma` fell back to downloading the
latest published CLI instead of using the pinned version. Run `npm install`
in the project root, then `npx prisma --version` should report 5.x.

**`prisma:deploy` fails with `P3018: type "X" already exists`**: see
[Recovering from a failed baseline migration](#recovering-from-a-failed-baseline-migration)
above.

**`pg_dump: error: server version mismatch`**: your local `pg_dump` is
older than Neon's Postgres version. Easiest fix: use Neon's own branch
feature as your backup instead of local `pg_dump` (console -> Branches ->
Create branch). See the same section above for the `brew install libpq`
alternative if you specifically need a `.sql` file.

**Dashboard shows "Could not reach the API"**: usually `VITE_API_URL` is
unset or wrong in Vercel's environment variables, or CORS
(`DASHBOARD_ORIGIN` in Railway) doesn't exactly match the deployed Vercel
URL (including `https://`, no trailing slash). Run
`node scripts/verify-production.js` -- the CORS checks will surface this
directly.

**Sign-in redirects back with `?error=oauth_failed`**: check Railway logs
for the actual cause (logged server-side, never shown to the browser).
Common causes: `GITHUB_OAUTH_CALLBACK_URL` doesn't exactly match the
GitHub App's configured callback URL, or `GITHUB_APP_CLIENT_SECRET` is
wrong/expired.

**A PR opens but no deployment appears**: check, in order: is the repo's
`allowed` flag true (dashboard shows "Preview deployments: Enabled")? Is
`DEPLOYMENTS_ENABLED` and `KILL_SWITCH` correctly set (not accidentally
disabling everything)? Is the PR from a fork with `needsApproval: true`
sitting unapproved? Check the repo's `deployment_events` table / dashboard
events panel for the actual reason once a Deployment row does exist.

---

## Rollback procedure

**Rolling back a bad backend deploy (Railway)**: Railway keeps previous
deployments -- in the Railway dashboard, go to the service's Deployments
tab and click "Redeploy" on the last known-good one. This does NOT roll
back the database schema; only use this alone if the bad deploy didn't
also ship a migration.

**Rolling back a bad migration**: migrations in this project are
additive-only by convention so far (new tables/columns, not destructive
changes) -- there is currently no "down" migration tooling. If a migration
needs to be reverted:
1. Confirm via `npx prisma migrate status` which migration is the problem.
2. Back up first (Neon branch or `pg_dump`), same as any other schema
   operation.
3. Hand-write a reverse migration (drop the added table/column) rather
   than trying to force Prisma to "undo" -- Prisma's migration history is
   forward-only by design.
4. Test the reverse migration against a Neon branch before applying to
   production.

**Rolling back a bad frontend deploy (Vercel)**: Vercel's dashboard ->
Deployments -> find the last good deployment -> "Promote to Production".
Instant, no build step, since it's just re-pointing the production alias.

**Emergency stop without a full rollback**: set `KILL_SWITCH=true` in
Railway's environment variables for the worker/reaper services. Takes
effect on the next poll tick, no restart needed, and stops all new
provisioning while leaving existing LIVE deployments running.

---

## Final verification status

Per the instruction not to call this production-ready without real
end-to-end verification, here is exactly what was and wasn't done in this
environment.

**Status as of this update: this round added GitHub OAuth login,
multi-tenant Membership-based authorization, and removed the manual
API-key dashboard entry UX. None of the new auth flow has been exercised
against a live GitHub OAuth app or a live deployed instance from this
environment** — that requires real `GITHUB_APP_CLIENT_ID` /
`GITHUB_APP_CLIENT_SECRET` and a real browser round-trip through
github.com, neither of which this sandbox can do. Everything below marked
"Implemented but not production-verified" needs a real run before this
is READY.

**Independently verified against the real deployed infrastructure** (via
`web_fetch`, not assumed from your description, from an earlier point in
this project):
- `https://prreview-production-7f5b.up.railway.app/api/repos` returned
  HTTP 401 without a key.
- `https://prpreview-omega.vercel.app` served the actual dashboard HTML.
- Neither of these reflects the code shipped in THIS round (OAuth login,
  new routes, new frontend) — they predate it. Re-verification after
  deploying this round's changes is required, not assumed to still hold.

**Verified in this environment (code-level):**
- Backend typecheck (`npx tsc --noEmit`) — clean.
- Backend production build (`npx tsc`) — clean.
- Dashboard typecheck (`npx tsc -b --noEmit`) — clean.
- Dashboard production build (`npx vite build`), built WITH
  `VITE_API_URL` set to the production Railway URL — clean; grepped to
  confirm the Railway URL is embedded in the output JS and that no
  `X-API-Key`/`prpk_` references remain anywhere in `web/src`.
- Backend: 115/115 tests passing (`npm test` at root, scoped to `src/**`).
- Frontend: 11/11 tests passing (`cd web && npm test`).
- New this round, all via unit tests / mocked fetch (no live network):
  session token sign/verify (valid, tampered, wrong secret, expired,
  malformed), OAuth CSRF state sign/verify (same cases plus timing via
  fake timers), the full GitHub OAuth request/response contract against
  fixtures matching GitHub's documented shapes, the GitHub OAuth client's
  full exchange-code + fetch-profile flow via injected mock fetch, the
  dual-mode (session + API key) authorization boundary including
  cross-membership isolation and session-vs-API-key precedence, and the
  `installation` webhook's suspend/unsuspend/deleted/created routing
  logic (specifically: unsuspend never silently re-enables repos).

**NOT verified in this environment (no network/credentials access here):**
- No real GitHub OAuth login was performed — `github.com/login/oauth/*`
  was never actually called; only fixture/mock-based tests exist.
- No real installation webhook was received — the `sender`-based
  User/Membership creation was never exercised against a real GitHub
  payload.
- No real session token was verified across a real HTTP request to a
  live server — `resolveAuth`'s DB-backed paths (`Membership.findMany`,
  `RevokedSession.findUnique`) are unit-tested against a mock client, not
  a live Postgres.
- No real cross-tenant HTTP request was sent to the running Fastify app
  to confirm a 403/404 in practice — the underlying authorization
  primitives are unit-tested, but no integration test drives an actual
  Fastify `inject()` or live HTTP call through the full route stack.
- The new `20260808000000_multi_tenant_auth` migration was hand-authored
  (same caveat as `0_baseline`) and has never been run against a live
  Postgres from this environment.
- Migration baseline status from the previous incident is still whatever
  the operator last reported, unconfirmed independently since.

**Remaining production blockers, in priority order:**
1. Run `npx prisma migrate status` against real Neon and confirm both
   `0_baseline` and `20260808000000_multi_tenant_auth` show applied
   cleanly.
2. Set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
   `GITHUB_OAUTH_CALLBACK_URL`, and `SESSION_SECRET` in Railway; confirm
   the GitHub App's OAuth callback URL matches exactly.
3. Deploy this round's backend + frontend changes, then perform one real
   "Continue with GitHub" login end to end in a browser, confirming: the
   redirect to GitHub, the callback, the one-time-code exchange, and a
   working `/api/me` response.
4. Confirm a real `installation` webhook delivery creates the expected
   Organization + User + Membership rows (check via the Railway
   Postgres console or a temporary debug endpoint, then remove it).
5. Run `node scripts/verify-production.js` against the real production
   URLs (unauthenticated 401, CORS, malformed-signature-rejection checks
   at minimum still apply and should be re-run after this deploy).
6. Exercise the full lifecycle (open PR → LIVE → new commit → close) once
   against the live Railway backend with a real signed-in session,
   confirming the dashboard never shows LIVE before the health check
   passes, and that the preview URL opens without any prpreview login.
7. Manually confirm cross-org isolation with two real GitHub accounts
   belonging to different orgs — the strongest test of the multi-tenant
   boundary is two real humans, not just unit tests.

Until items 1–7 are done, this is: a codebase with a real, tested
authorization boundary and a real, tested OAuth request/response
contract, deployed to infrastructure that was confirmed reachable at an
earlier point in this project — but this round's auth rewrite itself has
not been proven against live GitHub, live Postgres, or a live browser
session. **Implemented but not production-verified** applies to the
entire GitHub OAuth flow and multi-tenant Membership model as of this
writing.

---

## Five-question customer discovery script

1. "Walk me through what happens today when a reviewer wants to click
   through a PR's actual behavior, not just read the diff."
2. "How many of your PRs touch something that's hard to reproduce locally -
   a database migration, a queue consumer, a third-party webhook?"
3. "If a PR got a real, working URL automatically, who besides engineers
   would use it - PM, QA, design?"
4. "What do you currently pay for preview/staging infrastructure, and
   who owns that budget?"
5. "What would make you NOT trust an automated preview enough to rely on
   it for review sign-off?"
