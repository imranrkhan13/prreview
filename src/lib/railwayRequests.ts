/**
 * Pure functions that build Railway GraphQL request bodies and parse their
 * responses. Kept separate from railwayClient.ts (the transport) and
 * RailwayProvider.ts (the DeploymentProvider adapter) specifically so the
 * *shape* of every request/response can be unit-tested against fixtures
 * without touching the network — see railwayRequests.test.ts.
 */

export interface RailwayServiceCreateVars {
  input: {
    projectId: string;
    environmentId: string;
    name: string;
    source: { repo: string };
    variables: Record<string, string>;
  };
}

export function buildServiceCreateRequest(params: {
  projectId: string;
  environmentId: string;
  prNumber: number;
  deploymentId: string;
  repoFullName: string;
  allowedEnv: Record<string, string>;
}): { query: string; variables: RailwayServiceCreateVars } {
  return {
    query: `
      mutation ServiceCreate($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }
    `,
    variables: {
      input: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        name: `pr-${params.prNumber}-${params.deploymentId.slice(0, 8)}`,
        source: { repo: params.repoFullName },
        variables: params.allowedEnv,
      },
    },
  };
}

export function parseServiceCreateResponse(data: unknown): { serviceId: string } {
  const serviceId = (data as { serviceCreate?: { id?: string } })?.serviceCreate?.id;
  if (!serviceId || typeof serviceId !== "string") {
    throw new Error(
      `Unexpected serviceCreate response shape: expected { serviceCreate: { id } }, got ${JSON.stringify(data)}`
    );
  }
  return { serviceId };
}

export function buildDeployRequest(params: {
  serviceId: string;
  environmentId: string;
  commitSha: string;
}): { query: string; variables: Record<string, string> } {
  return {
    query: `
      mutation Deploy($serviceId: String!, $environmentId: String!, $commitSha: String) {
        serviceInstanceDeployV2(
          serviceId: $serviceId
          environmentId: $environmentId
          commitSha: $commitSha
        )
      }
    `,
    variables: {
      serviceId: params.serviceId,
      environmentId: params.environmentId,
      commitSha: params.commitSha,
    },
  };
}

export function buildDomainCreateRequest(params: { serviceId: string; environmentId: string }): {
  query: string;
  variables: { input: { serviceId: string; environmentId: string } };
} {
  return {
    query: `
      mutation Domain($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { domain }
      }
    `,
    variables: { input: { serviceId: params.serviceId, environmentId: params.environmentId } },
  };
}

export function parseDomainCreateResponse(data: unknown): { domain: string } {
  const domain = (data as { serviceDomainCreate?: { domain?: string } })?.serviceDomainCreate
    ?.domain;
  if (!domain || typeof domain !== "string") {
    throw new Error(
      `Unexpected serviceDomainCreate response shape: expected { serviceDomainCreate: { domain } }, got ${JSON.stringify(data)}`
    );
  }
  return { domain };
}

export function buildGetDomainRequest(params: { serviceId: string }): {
  query: string;
  variables: { id: string };
} {
  return {
    query: `
      query GetDomain($id: String!) {
        service(id: $id) { domains { serviceDomains { domain } } }
      }
    `,
    variables: { id: params.serviceId },
  };
}

export function parseGetDomainResponse(data: unknown): { domain: string | null } {
  const domains = (
    data as { service?: { domains?: { serviceDomains?: { domain?: string }[] } } }
  )?.service?.domains?.serviceDomains;
  const domain = Array.isArray(domains) ? domains[0]?.domain ?? null : null;
  return { domain: domain ?? null };
}

export function buildServiceDeleteRequest(params: { serviceId: string }): {
  query: string;
  variables: { id: string };
} {
  return {
    query: `mutation Delete($id: String!) { serviceDelete(id: $id) }`,
    variables: { id: params.serviceId },
  };
}
