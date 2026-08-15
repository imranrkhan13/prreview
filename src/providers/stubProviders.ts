import {
  DeploymentProvider,
  NotImplementedProviderError,
  ProvisionInput,
  ProvisionResult,
  UpdateInput,
  DeploymentProviderLogs,
} from "./DeploymentProvider.js";

/**
 * Shared skeleton for not-yet-built cloud providers. Every method throws
 * immediately. This exists so the ProviderType enum and dashboard UI can
 * reference these providers by name (for future roadmap display) without
 * any risk of the worker silently treating a stub as a successful
 * deployment.
 */
function makeStubProvider(name: string): DeploymentProvider {
  return {
    name,
    isRealDeployment: false,
    async provision(_input: ProvisionInput): Promise<ProvisionResult> {
      throw new NotImplementedProviderError(name);
    },
    async update(_input: UpdateInput): Promise<ProvisionResult> {
      throw new NotImplementedProviderError(name);
    },
    async teardown(_providerRef: string): Promise<void> {
      throw new NotImplementedProviderError(name);
    },
    async getLogs(_providerRef: string): Promise<DeploymentProviderLogs> {
      throw new NotImplementedProviderError(name);
    },
    async isHealthy(_providerRef: string): Promise<boolean> {
      throw new NotImplementedProviderError(name);
    },
  };
}

export const VercelProvider = makeStubProvider("VERCEL");
export const RenderProvider = makeStubProvider("RENDER");
export const FlyIoProvider = makeStubProvider("FLY_IO");
export const KubernetesProvider = makeStubProvider("KUBERNETES");
