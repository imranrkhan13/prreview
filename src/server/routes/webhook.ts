import { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { verifyWebhookSignature } from "../../lib/verifyWebhookSignature.js";
import { env } from "../../lib/env.js";
import { computeNeedsApproval } from "../../lib/approvalDecision.js";
import { hashKey } from "../accessControl.js";
import {
  parseInstallationEvent,
  parseInstallationRepositoriesEvent,
  decideInstallationAction,
} from "../../lib/installationEvents.js";

interface GithubPullRequestPayload {
  action: "opened" | "synchronize" | "reopened" | "closed" | string;
  number: number;
  pull_request: {
    title: string;
    merged: boolean;
    head: { sha: string; repo: { fork: boolean } };
    base: { sha: string };
    user: { login: string };
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: { id: number };
}

const RELEVANT_ACTIONS = new Set(["opened", "synchronize", "reopened", "closed"]);

export async function registerWebhookRoute(app: FastifyInstance) {
  app.post(
    "/webhooks/github",
    async (request: FastifyRequest, reply) => {
      // Raw body is captured by the custom content-type parser registered
      // in server/index.ts (see addContentTypeParser for application/json),
      // which stashes the untouched Buffer on request.rawBody BEFORE
      // JSON.parse runs. Signature verification MUST use these exact bytes.
      const rawBody = (request as unknown as { rawBody: Buffer }).rawBody;
      const signature = request.headers["x-hub-signature-256"];
      const deliveryId = request.headers["x-github-delivery"];
      const eventType = request.headers["x-github-event"];

      if (typeof deliveryId !== "string") {
        return reply.code(400).send({ error: "Missing X-GitHub-Delivery header" });
      }

      const validSignature = verifyWebhookSignature({
        rawBody,
        signatureHeader: signature,
        secret: env.GITHUB_WEBHOOK_SECRET,
      });

      if (!validSignature) {
        request.log.warn({ deliveryId }, "Rejected webhook: invalid signature");
        return reply.code(401).send({ error: "Invalid signature" });
      }

      // Idempotency: GitHub retries deliveries on timeout/5xx. Recording the
      // delivery ID up front (unique constraint) means a duplicate delivery
      // is a no-op, not a duplicate deployment.
      const payloadHash = createHash("sha256").update(rawBody).digest("hex");
      const existing = await prisma.webhookDelivery.findUnique({
        where: { githubDeliveryId: deliveryId },
      });

      if (existing) {
        request.log.info({ deliveryId }, "Duplicate webhook delivery, skipping");
        return reply.code(200).send({ status: "duplicate_ignored" });
      }

      await prisma.webhookDelivery.create({
        data: { githubDeliveryId: deliveryId, eventType: String(eventType), payloadHash },
      });

      if (eventType === "installation") {
        await handleInstallationEvent(request.body, request.log);
        return reply.code(200).send({ status: "accepted" });
      }

      if (eventType === "installation_repositories") {
        await handleInstallationRepositoriesEvent(request.body, request.log);
        return reply.code(200).send({ status: "accepted" });
      }

      if (eventType !== "pull_request") {
        return reply.code(202).send({ status: "ignored_event_type" });
      }

      const payload = request.body as GithubPullRequestPayload;

      if (!RELEVANT_ACTIONS.has(payload.action)) {
        return reply.code(202).send({ status: "ignored_action" });
      }

      const repository = await prisma.repository.findUnique({
        where: { githubRepoId: BigInt(payload.repository.id) },
      });

      if (!repository) {
        request.log.warn(
          { repo: payload.repository.full_name },
          "Webhook for unregistered repository, ignoring"
        );
        return reply.code(202).send({ status: "repo_not_registered" });
      }

      if (!repository.allowed) {
        request.log.warn(
          { repo: payload.repository.full_name },
          "Webhook for repository not opted in to previews, ignoring"
        );
        return reply.code(202).send({ status: "repo_not_allowed" });
      }

      await handlePullRequestEvent(repository.id, payload);

      return reply.code(200).send({ status: "accepted" });
    }
  );
}

async function handlePullRequestEvent(repoId: string, payload: GithubPullRequestPayload) {
  const isFork = payload.pull_request.head.repo?.fork ?? false;
  const repo = await prisma.repository.findUniqueOrThrow({ where: { id: repoId } });

  // Public-URL providers (Railway) run the PR's code somewhere reachable
  // by anyone on the internet. A PR from a fork is, by definition, code an
  // outside contributor wrote — auto-deploying it publicly without review
  // is a real abuse vector (crypto-mining, DoS launch point, scraping).
  // Same-repo branches are implicitly trusted (only collaborators can push
  // to them); forks require the repo owner to explicitly opt in via
  // `allowForkPrs`, or a human approves each one from the dashboard.
  const needsApproval = computeNeedsApproval(isFork, repo.allowForkPrs);

  const pr = await prisma.pullRequest.upsert({
    where: {
      repoId_githubPrNumber: { repoId, githubPrNumber: payload.number },
    },
    create: {
      repoId,
      githubPrNumber: payload.number,
      title: payload.pull_request.title,
      authorLogin: payload.pull_request.user.login,
      isFork,
      needsApproval,
      baseSha: payload.pull_request.base.sha,
      headSha: payload.pull_request.head.sha,
      state: payload.action === "closed" ? (payload.pull_request.merged ? "MERGED" : "CLOSED") : "OPEN",
    },
    update: {
      title: payload.pull_request.title,
      headSha: payload.pull_request.head.sha,
      needsApproval,
      state: payload.action === "closed" ? (payload.pull_request.merged ? "MERGED" : "CLOSED") : "OPEN",
    },
  });

  if (payload.action === "closed") {
    // Cleanup path: mark the latest active deployment for teardown. The
    // worker (not this handler) actually stops the container — this route
    // only records intent so the webhook responds fast.
    const activeDeployment = await prisma.deployment.findFirst({
      where: { prId: pr.id, status: { in: ["LIVE", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "UPDATING", "QUEUED"] } },
      orderBy: { createdAt: "desc" },
    });

    if (activeDeployment) {
      await prisma.deploymentEvent.create({
        data: {
          deploymentId: activeDeployment.id,
          type: "teardown_requested",
          message: `PR ${payload.action} (merged=${payload.pull_request.merged}); teardown queued`,
        },
      });
    }
    return;
  }

  // opened / synchronize / reopened -> ensure a deployment is queued,
  // UNLESS this PR needs manual approval first (untrusted fork + public
  // provider). In that case we stop here; a repo admin approves via
  // POST /api/prs/:id/approve, which is what actually creates the
  // Deployment row.
  if (needsApproval) return;

  const existingActive = await prisma.deployment.findFirst({
    where: { prId: pr.id, status: { in: ["LIVE", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "UPDATING", "QUEUED"] } },
  });

  if (!existingActive) {
    await prisma.deployment.create({
      data: {
        prId: pr.id,
        provider: repo.defaultProvider,
        status: "QUEUED",
        commitSha: payload.pull_request.head.sha,
        demoMode: repo.defaultProvider === "LOCAL_DOCKER",
        expiresAt: null, // set when it goes LIVE
      },
    });
  }
}

/**
 * Handles GitHub App install/uninstall/suspend/unsuspend. Repository and
 * user identity are always derived from GitHub-assigned numeric IDs
 * (installation.account.id, repository.id, sender.id) — never from a
 * client-suppliable name — per the "do not trust repository names
 * supplied by clients" requirement.
 *
 * On first install for a new GitHub org, this creates an Organization row
 * AND upserts a User row + Membership (role OWNER) for the installer
 * (`payload.sender`) — this is what lets that person's subsequent GitHub
 * OAuth login resolve to this org via Membership, with no manual step.
 * An automation-only API key is still generated too (logged once), kept
 * as the secondary/automation auth path per the product's auth model.
 *
 * New repos are synced with `allowed: false` — previews are NEVER enabled
 * automatically just because the GitHub App was installed on a repo; a
 * user must explicitly enable each one from the dashboard
 * (POST /api/repos/:id/enable). This matches the "explicit repo opt-in"
 * scope constraint.
 *
 * suspend: disables all of the installation's repos (no new deployments)
 * but does NOT delete anything. unsuspend does NOT automatically
 * re-enable them — that's a deliberate choice: silently reactivating
 * preview deployment on unsuspend could surprise an org that suspended
 * for a reason unrelated to prpreview. A human re-enables explicitly,
 * same as any other repo enable action.
 */
async function handleInstallationEvent(rawBody: unknown, log: { info: Function; warn: Function }) {
  const parsed = parseInstallationEvent(rawBody as Parameters<typeof parseInstallationEvent>[0]);
  const decision = decideInstallationAction(parsed.action);

  if (decision.kind === "disable_all_repos") {
    // Disable, never delete — preserves deployment/PR history per the
    // "do not silently delete existing Neon data" constraint.
    const result = await prisma.repository.updateMany({
      where: { installationId: BigInt(parsed.installationId) },
      data: { allowed: false },
    });
    log.info(
      { installationId: parsed.installationId, action: parsed.action, disabledCount: result.count },
      decision.reason
    );
    return;
  }

  if (decision.kind === "noop_repos_stay_disabled") {
    log.info({ installationId: parsed.installationId }, `${decision.reason}; repos remain disabled until manually re-enabled`);
    return;
  }

  if (decision.kind === "unhandled") return; // permissions changes, etc — not handled yet

  // decision.kind === "sync_org_and_repos"

  let org = await prisma.organization.findUnique({ where: { githubOrgId: BigInt(parsed.githubOrgId) } });

  if (!org) {
    const apiKey = "prpk_" + randomBytes(24).toString("hex");
    org = await prisma.organization.create({
      data: {
        githubOrgId: BigInt(parsed.githubOrgId),
        name: parsed.orgName,
        apiKeyHash: hashKey(apiKey),
      },
    });
    // Logged once, deliberately loud — this is the only place this key is
    // ever visible again after this line executes. Primary dashboard auth
    // is GitHub OAuth (via the Membership created below); this key remains
    // available for automation/testing only.
    log.warn(
      { orgId: org.id, githubOrgId: parsed.githubOrgId },
      `New organization "${parsed.orgName}" created from GitHub App install. ` +
        `One-time automation API key (save this now, it cannot be retrieved again): ${apiKey}`
    );
  }

  // Link the installer to this org so their next GitHub OAuth login
  // resolves to it via Membership -- no manual account-linking step.
  const installerUser = await prisma.user.upsert({
    where: { githubUserId: BigInt(parsed.sender.githubUserId) },
    create: {
      githubUserId: BigInt(parsed.sender.githubUserId),
      login: parsed.sender.login,
      avatarUrl: parsed.sender.avatarUrl,
    },
    update: { login: parsed.sender.login, avatarUrl: parsed.sender.avatarUrl },
  });

  await prisma.membership.upsert({
    where: { userId_orgId: { userId: installerUser.id, orgId: org.id } },
    create: { userId: installerUser.id, orgId: org.id, role: "OWNER" },
    update: {}, // don't downgrade an existing membership's role just because they reinstalled
  });

  for (const repo of parsed.repositories) {
    await prisma.repository.upsert({
      where: { githubRepoId: BigInt(repo.githubRepoId) },
      create: {
        orgId: org.id,
        githubRepoId: BigInt(repo.githubRepoId),
        fullName: repo.fullName,
        installationId: BigInt(parsed.installationId),
        allowed: false, // never auto-enabled — see docstring above
        webhookSecretRef: "GITHUB_WEBHOOK_SECRET",
      },
      update: {
        fullName: repo.fullName,
        installationId: BigInt(parsed.installationId),
      },
    });
  }

  log.info(
    { orgId: org.id, installerUserId: installerUser.id, repoCount: parsed.repositories.length },
    "Synced repositories and installer membership from installation"
  );
}

/** Handles repos added/removed from an existing installation. Same identity and disable-not-delete rules as handleInstallationEvent. */
async function handleInstallationRepositoriesEvent(rawBody: unknown, log: { info: Function }) {
  const parsed = parseInstallationRepositoriesEvent(
    rawBody as Parameters<typeof parseInstallationRepositoriesEvent>[0]
  );

  const org = await prisma.organization.findUnique({ where: { githubOrgId: BigInt(parsed.githubOrgId) } });
  if (!org) {
    log.info({ githubOrgId: parsed.githubOrgId }, "installation_repositories event for unknown org, ignoring");
    return;
  }

  for (const repo of parsed.repositoriesAdded) {
    await prisma.repository.upsert({
      where: { githubRepoId: BigInt(repo.githubRepoId) },
      create: {
        orgId: org.id,
        githubRepoId: BigInt(repo.githubRepoId),
        fullName: repo.fullName,
        installationId: BigInt(parsed.installationId),
        allowed: false,
        webhookSecretRef: "GITHUB_WEBHOOK_SECRET",
      },
      update: { fullName: repo.fullName, installationId: BigInt(parsed.installationId) },
    });
  }

  if (parsed.repositoriesRemoved.length > 0) {
    await prisma.repository.updateMany({
      where: { githubRepoId: { in: parsed.repositoriesRemoved.map((r) => BigInt(r.githubRepoId)) } },
      data: { allowed: false },
    });
  }

  log.info(
    { orgId: org.id, added: parsed.repositoriesAdded.length, removed: parsed.repositoriesRemoved.length },
    "Synced installation_repositories change"
  );
}
