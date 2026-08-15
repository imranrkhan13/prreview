import {
  DeploymentProvider,
  ProvisionInput,
  ProvisionResult,
  UpdateInput,
  DeploymentProviderLogs,
} from "./DeploymentProvider.js";
import { railwayGraphQL, FetchLike } from "../lib/railwayClient.js";
import { assertValidRepoFullName } from "../lib/repoFullName.js";
import {
  buildServiceCreateRequest,
  parseServiceCreateResponse,
  buildDeployRequest,
  buildDomainCreateRequest,
  parseDomainCreateResponse,
  buildGetDomainRequest,
  parseGetDomainResponse,
  buildServiceDeleteRequest,
} from "../lib/railwayRequests.js";

// Reads process.env directly (rather than the frozen `env` singleton in
// lib/env.ts) specifically so tests can toggle credentials per-case without
// re-importing modules. lib/env.ts still performs the one-time boot-time
// check that APP_MODE=live has credentials present.
function requireRailwayConfig(): { token: string; projectId: string; environmentId: string } {
  const token = process.env.RAILWAY_API_TOKEN ?? "";
  const projectId = process.env.RAILWAY_PROJECT_ID ?? "";
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID ?? "";
  if (!token || !projectId || !environmentId) {
    throw new Error(
      "RailwayProvider requires RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, and " +
        "RAILWAY_ENVIRONMENT_ID to be set. Without these, no public preview can be created."
    );
  }
  return { token, projectId, environmentId };
}

/**
 * RailwayProvider is the real "publish it to the world" implementation.
 * Unlike LocalDockerProvider, the URL it returns
 * (`https://<slug>.up.railway.app`) is genuinely reachable by anyone on
 * the internet — not just the operator's machine.
 *
 * Scope enforced upstream (not in this file):
 * - Only repos an org owner has explicitly opted in (`repository.allowed
 *   = true`) ever reach this provider — see webhook.ts.
 * - PRs from forks are held for manual approval unless the repo owner
 *   opts into `allowForkPrs` — see webhook.ts and dashboardApi.ts.
 * - This provider only ever returns a URL; whether that URL is actually
 *   shown to users as "live" is decided by the worker's health-check gate
 *   (src/worker/processDeployment.ts), not by this file. A domain being
 *   created here does NOT mean the app behind it is reachable yet.
 *
 * REQUEST/RESPONSE SHAPES: built via src/lib/railwayRequests.ts, which is
 * unit-tested against fixtures matching Railway's published docs — see
 * railwayRequests.test.ts. Those fixtures are NOT verified by live
 * introspection (this sandbox can't reach backboard.railway.com). Confirm
 * against railway.com/graphiql before trusting this against a real account.
 *
 * ISOLATION CAVEAT: Railway runs services in its own container
 * infrastructure. This is NOT equivalent to a hardened microVM sandbox
 * (Firecracker) or a syscall-filtering sandbox (gVisor) — treat any code
 * deployed this way as running with standard container-level isolation
 * only. Do not deploy previews for repositories whose code you would not
 * trust to run in a normal Docker container on shared infrastructure.
 */
export function createRailwayProvider(fetchImpl?: FetchLike): DeploymentProvider {
  return {
    name: "RAILWAY",
    isRealDeployment: true,

    async provision(input: ProvisionInput): Promise<ProvisionResult> {
      assertValidRepoFullName(input.repoFullName);
      const { token, projectId, environmentId } = requireRailwayConfig();

      const createReq = buildServiceCreateRequest({
        projectId,
        environmentId,
        prNumber: input.prNumber,
        deploymentId: input.deploymentId,
        repoFullName: input.repoFullName,
        allowedEnv: input.allowedEnv, // explicit allowlist only — never a full prod env
      });
      const createData = await railwayGraphQL({ token, ...createReq, fetchImpl });
      const { serviceId } = parseServiceCreateResponse(createData);

      // Deploy the exact PR commit, never an unpinned default branch.
      const deployReq = buildDeployRequest({ serviceId, environmentId, commitSha: input.commitSha });
      await railwayGraphQL({ token, ...deployReq, fetchImpl });

      const domainReq = buildDomainCreateRequest({ serviceId, environmentId });
      const domainData = await railwayGraphQL({ token, ...domainReq, fetchImpl });
      const { domain } = parseDomainCreateResponse(domainData);

      return {
        // NOTE: this URL is returned to the worker, which must health-check
        // it before it's ever persisted/shown as the deployment's live URL.
        url: `https://${domain}`,
        providerRef: serviceId,
      };
    },

    async update(input: UpdateInput): Promise<ProvisionResult> {
      const { token, environmentId } = requireRailwayConfig();
      const serviceId = input.providerRef;

      const deployReq = buildDeployRequest({ serviceId, environmentId, commitSha: input.commitSha });
      await railwayGraphQL({ token, ...deployReq, fetchImpl });

      // Domain is stable across redeploys once created; re-fetch rather
      // than re-issuing serviceDomainCreate (which would create a second one).
      const getDomainReq = buildGetDomainRequest({ serviceId });
      const data = await railwayGraphQL({ token, ...getDomainReq, fetchImpl });
      const { domain } = parseGetDomainResponse(data);

      if (!domain) throw new Error(`No domain found for redeployed service ${serviceId}`);

      return { url: `https://${domain}`, providerRef: serviceId };
    },

    async teardown(providerRef: string): Promise<void> {
      const { token } = requireRailwayConfig();
      const req = buildServiceDeleteRequest({ serviceId: providerRef });
      await railwayGraphQL({ token, ...req, fetchImpl });
    },

    async getLogs(_providerRef: string): Promise<DeploymentProviderLogs> {
      // Railway delivers logs as a GraphQL subscription over WebSocket, not
      // a simple request/response query — this provider interface is
      // request/response only, so streaming logs are out of scope here.
      // Documented gap, not silently faked.
      return {
        lines: [
          "Live log streaming from Railway is not implemented in this MVP.",
          "View logs directly in the Railway dashboard for this service until subscription support is added.",
        ],
      };
    },

    async isHealthy(providerRef: string): Promise<boolean> {
      // This checks whether the Railway SERVICE still exists — it does NOT
      // check whether the app behind it is responding to HTTP requests.
      // Application-level reachability is what the worker's health-check
      // gate (src/worker/healthCheck.ts) verifies before marking LIVE.
      const { token } = requireRailwayConfig();
      try {
        const data = await railwayGraphQL<{ service: { id: string } | null }>({
          token,
          query: `query Get($id: String!) { service(id: $id) { id } }`,
          variables: { id: providerRef },
          fetchImpl,
        });
        return data.service !== null;
      } catch {
        return false;
      }
    },
  };
}

/** Default instance used by the provider registry (real fetch). */
export const RailwayProvider = createRailwayProvider();
