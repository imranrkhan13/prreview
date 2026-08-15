import { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, AuthedRequest2 } from "./middleware.js";
import { providerRegistry } from "../../providers/registry.js";
import { decideApproval } from "../../lib/approvalDecision.js";

// Deliberately local, minimal shapes for map callbacks below, rather than
// importing model types from @prisma/client here. Keeps this file
// type-checkable even in environments where `prisma generate` couldn't
// reach binaries.prisma.sh to build the full client; on a normal dev/CI
// machine the real Prisma types are structurally compatible with these.
interface RepoRow {
  id: string;
  orgId: string;
  fullName: string;
  allowed: boolean;
  createdAt: Date;
}
interface DeploymentRow {
  id: string;
  status: string;
  url: string | null;
  commitSha: string;
  demoMode: boolean;
  failureReason: string | null;
  healthCheckAttempts: number;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}
interface PrRow {
  id: string;
  githubPrNumber: number;
  title: string;
  authorLogin: string;
  isFork: boolean;
  needsApproval: boolean;
  state: string;
  createdAt: Date;
  updatedAt: Date;
  deployments: DeploymentRow[];
}
interface EventRow {
  type: string;
  message: string;
  createdAt: Date;
}

export async function registerDashboardApiRoutes(app: FastifyInstance) {
  // Every /api/* route except the public OAuth entry points (registered
  // separately in auth.ts, and excluded from this hook by path) requires
  // resolved auth. `request.auth.authorizedOrgIds` is the ONLY source of
  // truth for which orgs' data a caller may see -- every query below
  // filters by it, never by a client-supplied orgId.
  app.addHook("preHandler", async (request, reply) => {
    const publicAuthPaths = [
      "/api/auth/github/login",
      "/api/auth/github/callback",
      "/api/auth/exchange",
      "/api/auth/logout",
    ];
    if (request.url.startsWith("/api/") && !publicAuthPaths.some((p) => request.url.startsWith(p))) {
      await requireAuth(request, reply);
    }
  });

  // GET /api/organizations - every org the caller belongs to (session) or their single org (API key)
  app.get("/api/organizations", async (request) => {
    const auth = (request as AuthedRequest2).auth!;
    const orgs = await prisma.organization.findMany({
      where: { id: { in: auth.authorizedOrgIds } },
      orderBy: { name: "asc" },
    });
    return orgs.map((o: { id: string; name: string }) => ({ id: o.id, name: o.name }));
  });

  // GET /api/repos - repos visible across every org the caller is authorized for
  app.get("/api/repos", async (request) => {
    const auth = (request as AuthedRequest2).auth!;
    const repos = await prisma.repository.findMany({
      where: { orgId: { in: auth.authorizedOrgIds } },
      orderBy: { fullName: "asc" },
    });
    return repos.map((r: RepoRow) => ({
      id: r.id,
      orgId: r.orgId,
      fullName: r.fullName,
      allowed: r.allowed,
      createdAt: r.createdAt,
    }));
  });

  // GET /api/repos/:repoId/prs - PRs + latest deployment summary for a repo
  app.get("/api/repos/:repoId/prs", async (request, reply) => {
    const auth = (request as AuthedRequest2).auth!;
    const { repoId } = request.params as { repoId: string };

    const repo = await prisma.repository.findFirst({
      where: { id: repoId, orgId: { in: auth.authorizedOrgIds } },
    });
    if (!repo) return reply.code(404).send({ error: "Repository not found" });

    const prs = await prisma.pullRequest.findMany({
      where: { repoId },
      orderBy: { updatedAt: "desc" },
      include: {
        deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    return prs.map((pr: PrRow) => {
      const latest = pr.deployments[0];
      return {
        id: pr.id,
        number: pr.githubPrNumber,
        title: pr.title,
        author: pr.authorLogin,
        state: pr.state,
        isFork: pr.isFork,
        needsApproval: pr.needsApproval,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        deployment: latest
          ? {
              id: latest.id,
              status: latest.status,
              url: latest.url,
              commitSha: latest.commitSha,
              demoMode: latest.demoMode,
              failureReason: latest.failureReason,
              healthCheckAttempts: latest.healthCheckAttempts,
              lastHealthCheckAt: latest.lastHealthCheckAt,
              createdAt: latest.createdAt,
              updatedAt: latest.updatedAt,
              expiresAt: latest.expiresAt,
            }
          : null,
      };
    });
  });

  // GET /api/deployments/:id - single deployment detail
  app.get("/api/deployments/:id", async (request, reply) => {
    const auth = (request as AuthedRequest2).auth!;
    const { id } = request.params as { id: string };

    const deployment = await prisma.deployment.findFirst({
      where: { id, pr: { repo: { orgId: { in: auth.authorizedOrgIds } } } },
    });
    if (!deployment) return reply.code(404).send({ error: "Deployment not found" });

    return {
      id: deployment.id,
      status: deployment.status,
      url: deployment.url,
      commitSha: deployment.commitSha,
      demoMode: deployment.demoMode,
      failureReason: deployment.failureReason,
      healthCheckAttempts: deployment.healthCheckAttempts,
      lastHealthCheckAt: deployment.lastHealthCheckAt,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
      expiresAt: deployment.expiresAt,
    };
  });

  // GET /api/deployments/:id/events - visible log/state trail for one deployment
  app.get("/api/deployments/:id/events", async (request, reply) => {
    const auth = (request as AuthedRequest2).auth!;
    const { id } = request.params as { id: string };

    const deployment = await prisma.deployment.findFirst({
      where: { id, pr: { repo: { orgId: { in: auth.authorizedOrgIds } } } },
    });
    if (!deployment) return reply.code(404).send({ error: "Deployment not found" });

    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: id },
      orderBy: { createdAt: "asc" },
    });

    return events.map((e: EventRow) => ({ type: e.type, message: e.message, createdAt: e.createdAt }));
  });

  // GET /api/deployments/:id/logs - live container logs (LOCAL_DOCKER only)
  app.get("/api/deployments/:id/logs", async (request, reply) => {
    const auth = (request as AuthedRequest2).auth!;
    const { id } = request.params as { id: string };

    const deployment = await prisma.deployment.findFirst({
      where: { id, pr: { repo: { orgId: { in: auth.authorizedOrgIds } } } },
    });
    if (!deployment) return reply.code(404).send({ error: "Deployment not found" });

    if (deployment.status !== "LIVE" && deployment.status !== "UPDATING" && deployment.status !== "HEALTH_CHECK") {
      return { lines: [], note: "Logs are only available while a deployment is running." };
    }

    const provider = providerRegistry[deployment.provider as keyof typeof providerRegistry];
    try {
      const lastEvent = await prisma.deploymentEvent.findFirst({
        where: { deploymentId: id, type: "provider_ref" },
        orderBy: { createdAt: "desc" },
      });
      if (!lastEvent) return { lines: [], note: "No running container reference found." };
      const logs = await provider.getLogs(lastEvent.message);
      return logs;
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // POST /api/prs/:prId/approve - manually approve a fork PR for deployment
  // to a public provider. Authorization re-derived from the DB on every
  // request via decideApproval() -- the org-scoped lookup below is what
  // actually enforces "this PR belongs to one of the caller's orgs,"
  // needsApproval / hasActiveDeployment are read fresh from the database,
  // never trusted from anything the client sent.
  app.post("/api/prs/:prId/approve", async (request, reply) => {
    const auth = (request as AuthedRequest2).auth!;
    const { prId } = request.params as { prId: string };

    const pr = await prisma.pullRequest.findFirst({
      where: { id: prId, repo: { orgId: { in: auth.authorizedOrgIds } } },
      include: { repo: true },
    });

    const existingActive = pr
      ? await prisma.deployment.findFirst({
          where: {
            prId: pr.id,
            status: { in: ["LIVE", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "UPDATING", "QUEUED"] },
          },
        })
      : null;

    const decision = decideApproval({
      prFoundInRequestingOrg: pr !== null,
      needsApproval: pr?.needsApproval ?? false,
      hasActiveDeployment: existingActive !== null,
    });

    if (!decision.allowed) {
      return reply.code(decision.status).send({ error: decision.reason });
    }

    await prisma.pullRequest.update({ where: { id: pr!.id }, data: { needsApproval: false } });

    const deployment = await prisma.deployment.create({
      data: {
        prId: pr!.id,
        provider: pr!.repo.defaultProvider,
        status: "QUEUED",
        commitSha: pr!.headSha,
        demoMode: pr!.repo.defaultProvider === "LOCAL_DOCKER",
      },
    });

    return { id: deployment.id, status: deployment.status };
  });

  async function setRepoEnabled(request: AuthedRequest2, reply: FastifyReply, enabled: boolean) {
    const auth = request.auth!;
    const { repoId } = request.params as { repoId: string };

    const repo = await prisma.repository.findFirst({
      where: { id: repoId, orgId: { in: auth.authorizedOrgIds } },
    });
    if (!repo) return reply.code(404).send({ error: "Repository not found" });

    const updated = await prisma.repository.update({
      where: { id: repoId },
      data: { allowed: enabled },
    });

    return { id: updated.id, allowed: updated.allowed };
  }

  // POST /api/repos/:repoId/enable - opts a repo into previews. User must
  // explicitly do this per repo; the GitHub App having access to a repo
  // never auto-enables previews for it.
  app.post("/api/repos/:repoId/enable", async (request, reply) =>
    setRepoEnabled(request as AuthedRequest2, reply, true)
  );

  // POST /api/repos/:repoId/disable - turns previews back off. Does NOT
  // delete the repo or its deployment history, and does not tear down any
  // currently-live deployment (that happens naturally via PR close/TTL) --
  // it only stops NEW deployments from being queued for future PR events.
  app.post("/api/repos/:repoId/disable", async (request, reply) =>
    setRepoEnabled(request as AuthedRequest2, reply, false)
  );

  // POST /api/repos/:repoId/allow - deprecated alias for /enable, kept for
  // existing automation scripts that predate the enable/disable naming.
  app.post("/api/repos/:repoId/allow", async (request, reply) =>
    setRepoEnabled(request as AuthedRequest2, reply, true)
  );
}
