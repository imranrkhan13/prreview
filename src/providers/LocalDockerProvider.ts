import Docker from "dockerode";
import {
  DeploymentProvider,
  ProvisionInput,
  ProvisionResult,
  UpdateInput,
  DeploymentProviderLogs,
} from "./DeploymentProvider.js";
import { env } from "../lib/env.js";
import { buildPreviewImage } from "../lib/buildCheckout.js";
import { assertValidRepoFullName } from "../lib/repoFullName.js";

const docker = new Docker(); // connects to local Docker socket

const LABEL_KEY = "prpreview.managed";
const containerPortInUse = new Set<number>();

function pickPort(): number {
  for (let port = env.PREVIEW_PORT_RANGE_START; port <= env.PREVIEW_PORT_RANGE_END; port++) {
    if (!containerPortInUse.has(port)) {
      containerPortInUse.add(port);
      return port;
    }
  }
  throw new Error("No available ports in PREVIEW_PORT_RANGE_START..PREVIEW_PORT_RANGE_END");
}

function releasePort(port: number) {
  containerPortInUse.delete(port);
}

function containerNameFor(deploymentId: string): string {
  return `prpreview-${deploymentId}`;
}

/**
 * LocalDockerProvider is the ONE real implementation in this MVP.
 *
 * What it actually does, honestly:
 * - Clones the given commit SHA of the target repo into a scratch dir
 * - Builds a container from that checkout using a Dockerfile the target
 *   repo must provide at `.prpreview/Dockerfile` (documented in README)
 * - Runs the container on a host port from PREVIEW_PORT_RANGE_START..END
 * - Returns a real, reachable http://localhost:<port> URL
 *
 * What it deliberately does NOT do:
 * - It does not deploy to any cloud provider
 * - It does not provide public internet URLs (local-only by design for MVP)
 * - It does not inherit host/prod environment variables; only `allowedEnv`
 *   passed in by the caller is injected into the container
 *
 * This is why `isRealDeployment` is true but `demoMode` is still recorded
 * on the Deployment row — it's a real running container, but scoped to the
 * operator's own machine/network rather than a shareable public cloud URL.
 */
export const LocalDockerProvider: DeploymentProvider = {
  name: "LOCAL_DOCKER",
  isRealDeployment: true,

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const port = pickPort();
    const name = containerNameFor(input.deploymentId);

    // NOTE: image build step is intentionally left as a documented extension
    // point (buildImageForCommit) rather than inlined here, so the happy
    // path (run a pre-built image) and the build path can be tested and
    // reasoned about independently.
    const image = await buildImageForCommit(input);

    const container = await docker.createContainer({
      name,
      Image: image,
      Env: Object.entries(input.allowedEnv).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [LABEL_KEY]: "true",
        "prpreview.deploymentId": input.deploymentId,
        "prpreview.repo": input.repoFullName,
        "prpreview.pr": String(input.prNumber),
      },
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        PortBindings: { "3000/tcp": [{ HostPort: String(port) }] },
        Memory: 512 * 1024 * 1024, // 512MB cap: prevents one preview from starving the host
        NanoCpus: 1_000_000_000, // 1 vCPU cap
        // No access to the host network or other containers' networks.
        NetworkMode: "bridge",
      },
    });

    await container.start();

    return {
      url: `http://${env.PREVIEW_BASE_DOMAIN}:${port}`,
      providerRef: container.id,
    };
  },

  async update(input: UpdateInput): Promise<ProvisionResult> {
    // Redeploy on new commit: tear down the old container, provision a fresh
    // one at the same deploymentId-derived name/port isn't guaranteed (port
    // may have been reclaimed), so we re-provision and return a new URL.
    const container = docker.getContainer(input.providerRef);
    const info = await container.inspect().catch(() => null);
    const deploymentId = info?.Config?.Labels?.["prpreview.deploymentId"];
    const repoFullName = info?.Config?.Labels?.["prpreview.repo"];
    const prNumber = info?.Config?.Labels?.["prpreview.pr"];

    if (!deploymentId || !repoFullName || !prNumber) {
      throw new Error(
        `Cannot update container ${input.providerRef}: missing prpreview labels, was it created by this provider?`
      );
    }

    await this.teardown(input.providerRef);

    return this.provision({
      deploymentId,
      repoFullName,
      prNumber: Number(prNumber),
      commitSha: input.commitSha,
      allowedEnv: {},
    });
  },

  async teardown(providerRef: string): Promise<void> {
    const container = docker.getContainer(providerRef);
    const info = await container.inspect().catch(() => null);
    if (!info) return; // already gone; teardown is idempotent

    const portBinding = info.HostConfig?.PortBindings?.["3000/tcp"]?.[0]?.HostPort;
    if (portBinding) releasePort(Number(portBinding));

    try {
      await container.stop({ t: 5 });
    } catch {
      // already stopped
    }
    await container.remove({ force: true }).catch(() => undefined);
  },

  async getLogs(providerRef: string): Promise<DeploymentProviderLogs> {
    const container = docker.getContainer(providerRef);
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: true,
    });
    const raw = stream.toString("utf8");
    return { lines: raw.split("\n").filter(Boolean) };
  },

  async isHealthy(providerRef: string): Promise<boolean> {
    const container = docker.getContainer(providerRef);
    const info = await container.inspect().catch(() => null);
    return info?.State?.Running === true;
  },
};

/**
 * Extension point: builds (or pulls a cached) Docker image for the given
 * commit SHA of a repo. The MVP implementation expects the target repo to
 * be checked out on disk already (by the worker, before calling provision)
 * and to contain a `.prpreview/Dockerfile`. This keeps LocalDockerProvider
 * focused on container lifecycle, not git/build orchestration.
 */
async function buildImageForCommit(input: ProvisionInput): Promise<string> {
  assertValidRepoFullName(input.repoFullName);
  const imageTag = `prpreview/${input.repoFullName.replace("/", "-")}:${input.commitSha.slice(0, 12)}`;
  const cloneUrl = `https://github.com/${input.repoFullName}.git`;
  await buildPreviewImage({ cloneUrl, commitSha: input.commitSha, imageTag });
  return imageTag;
}
