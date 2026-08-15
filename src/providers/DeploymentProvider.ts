/**
 * DeploymentProvider is the boundary every backing infrastructure
 * implementation must satisfy. The MVP ships exactly one real
 * implementation (LocalDockerProvider). Vercel/Railway/Render/Fly.io/
 * Kubernetes adapters are NOT implemented yet — see the stub files in this
 * directory, which throw NotImplementedError rather than pretending to work.
 *
 * Product rule this interface enforces: a provider must never resolve
 * `provision`/`update` successfully unless a real environment is reachable.
 * The worker persists whatever status/url this returns directly to the
 * `deployments` table — there is no separate "pretend it's live" path.
 */

export interface ProvisionInput {
  deploymentId: string;
  repoFullName: string;
  prNumber: number;
  commitSha: string;
  /** Explicit allowlist of env vars to inject. Never the full prod .env. */
  allowedEnv: Record<string, string>;
}

export interface ProvisionResult {
  url: string;
  /** Provider-specific handle used for update/teardown/logs, e.g. container ID. */
  providerRef: string;
}

export interface UpdateInput {
  providerRef: string;
  commitSha: string;
}

export interface DeploymentProviderLogs {
  lines: string[];
}

export interface DeploymentProvider {
  readonly name: string;
  /** Whether this provider represents a real environment (true) or is a stub/demo (false). */
  readonly isRealDeployment: boolean;

  provision(input: ProvisionInput): Promise<ProvisionResult>;
  update(input: UpdateInput): Promise<ProvisionResult>;
  teardown(providerRef: string): Promise<void>;
  getLogs(providerRef: string): Promise<DeploymentProviderLogs>;
  /** Cheap liveness check used by the dashboard status refresh. */
  isHealthy(providerRef: string): Promise<boolean>;
}

export class NotImplementedProviderError extends Error {
  constructor(providerName: string) {
    super(
      `${providerName} is not implemented in this MVP. Only LOCAL_DOCKER is a real ` +
        `provider. Implement the DeploymentProvider interface before enabling this provider.`
    );
    this.name = "NotImplementedProviderError";
  }
}
