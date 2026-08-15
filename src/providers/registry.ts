import { DeploymentProvider } from "./DeploymentProvider.js";
import { LocalDockerProvider } from "./LocalDockerProvider.js";
import { RailwayProvider } from "./RailwayProvider.js";
import {
  VercelProvider,
  RenderProvider,
  FlyIoProvider,
  KubernetesProvider,
} from "./stubProviders.js";

export type ProviderTypeKey =
  | "LOCAL_DOCKER"
  | "VERCEL"
  | "RAILWAY"
  | "RENDER"
  | "FLY_IO"
  | "KUBERNETES";

export const providerRegistry: Record<ProviderTypeKey, DeploymentProvider> = {
  LOCAL_DOCKER: LocalDockerProvider,
  VERCEL: VercelProvider,
  RAILWAY: RailwayProvider,
  RENDER: RenderProvider,
  FLY_IO: FlyIoProvider,
  KUBERNETES: KubernetesProvider,
};

/** Private/local demo mode. Set a repo's defaultProvider to RAILWAY for real public URLs. */
export const DEFAULT_PROVIDER: ProviderTypeKey = "LOCAL_DOCKER";
