import { describe, it, expect } from "vitest";
import {
  buildServiceCreateRequest,
  parseServiceCreateResponse,
  buildDeployRequest,
  buildDomainCreateRequest,
  parseDomainCreateResponse,
  buildGetDomainRequest,
  parseGetDomainResponse,
  buildServiceDeleteRequest,
} from "./railwayRequests.js";

// Fixtures below mirror the exact shapes shown in Railway's published docs
// (docs.railway.com/guides/api-cookbook, docs.railway.com/guides/manage-services)
// as of this writing. This is the documented "integration-test seam": since
// this sandbox cannot reach backboard.railway.com, these tests verify the
// request/response CONTRACT this code relies on, so that if Railway's
// actual API disagrees, re-running these tests against captured real
// responses (swap the fixture for a real one) will fail loudly instead of
// the app silently mis-parsing a live response.

describe("buildServiceCreateRequest", () => {
  it("builds a request matching Railway's documented ServiceCreateInput shape", () => {
    const { variables } = buildServiceCreateRequest({
      projectId: "proj_1",
      environmentId: "env_1",
      prNumber: 42,
      deploymentId: "deploy_abcdef1234567890",
      repoFullName: "demo-org/sample-app",
      allowedEnv: { PREVIEW: "true" },
    });

    expect(variables.input.projectId).toBe("proj_1");
    expect(variables.input.environmentId).toBe("env_1");
    expect(variables.input.source).toEqual({ repo: "demo-org/sample-app" });
    expect(variables.input.variables).toEqual({ PREVIEW: "true" });
    // deploymentId is truncated to 8 chars in the service name, per docs
    // recommending short, human-scannable service names
    expect(variables.input.name).toBe("pr-42-deploy_a");
  });

  it("parses the documented { serviceCreate: { id } } response shape", () => {
    const fixture = { serviceCreate: { id: "svc_123", name: "pr-42-deploy_a" } };
    expect(parseServiceCreateResponse(fixture)).toEqual({ serviceId: "svc_123" });
  });

  it("throws a clear error on an unexpected response shape (contract violation)", () => {
    expect(() => parseServiceCreateResponse({ somethingElse: true })).toThrow(
      /Unexpected serviceCreate response shape/
    );
  });
});

describe("buildDeployRequest", () => {
  it("always includes the exact commit SHA, never omitting it for a default-branch deploy", () => {
    const { variables } = buildDeployRequest({
      serviceId: "svc_123",
      environmentId: "env_1",
      commitSha: "abc123def456",
    });
    expect(variables.commitSha).toBe("abc123def456");
    expect(variables.serviceId).toBe("svc_123");
  });
});

describe("buildDomainCreateRequest / parseDomainCreateResponse", () => {
  it("builds a request matching Railway's documented ServiceDomainCreateInput shape", () => {
    const { variables } = buildDomainCreateRequest({ serviceId: "svc_123", environmentId: "env_1" });
    expect(variables.input).toEqual({ serviceId: "svc_123", environmentId: "env_1" });
  });

  it("parses the documented { serviceDomainCreate: { domain } } response shape", () => {
    const fixture = { serviceDomainCreate: { domain: "pr-42-deploy-a.up.railway.app" } };
    expect(parseDomainCreateResponse(fixture)).toEqual({ domain: "pr-42-deploy-a.up.railway.app" });
  });

  it("throws on a missing domain field rather than returning an empty/undefined URL", () => {
    expect(() => parseDomainCreateResponse({ serviceDomainCreate: {} })).toThrow(
      /Unexpected serviceDomainCreate response shape/
    );
  });
});

describe("buildGetDomainRequest / parseGetDomainResponse", () => {
  it("parses a populated domains list", () => {
    const fixture = {
      service: { domains: { serviceDomains: [{ domain: "pr-42.up.railway.app" }] } },
    };
    expect(parseGetDomainResponse(fixture)).toEqual({ domain: "pr-42.up.railway.app" });
  });

  it("returns null (not a throw) when no domain exists yet, so callers can decide how to handle it", () => {
    const fixture = { service: { domains: { serviceDomains: [] } } };
    expect(parseGetDomainResponse(fixture)).toEqual({ domain: null });
  });

  it("handles a missing service gracefully", () => {
    expect(parseGetDomainResponse({ service: null })).toEqual({ domain: null });
  });
});

describe("buildServiceDeleteRequest", () => {
  it("targets the exact service id being torn down", () => {
    const { variables } = buildServiceDeleteRequest({ serviceId: "svc_123" });
    expect(variables).toEqual({ id: "svc_123" });
  });
});
