import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRailwayProvider } from "./RailwayProvider.js";
import { FetchLike } from "../lib/railwayClient.js";

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  process.env.RAILWAY_API_TOKEN = "test-token";
  process.env.RAILWAY_PROJECT_ID = "proj_1";
  process.env.RAILWAY_ENVIRONMENT_ID = "env_1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("RailwayProvider (via injected mock fetch — no live network)", () => {
  it("provision(): creates service, deploys exact commit, creates domain, and returns a real URL", async () => {
    const calls: { query: string; variables: unknown }[] = [];
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push(body);
      if (body.query.includes("ServiceCreate")) {
        return jsonResponse({ data: { serviceCreate: { id: "svc_123", name: "pr-42-deploy_a" } } });
      }
      if (body.query.includes("Deploy(")) {
        return jsonResponse({ data: { serviceInstanceDeployV2: true } });
      }
      if (body.query.includes("Domain(")) {
        return jsonResponse({ data: { serviceDomainCreate: { domain: "pr-42.up.railway.app" } } });
      }
      throw new Error(`Unexpected query in test: ${body.query}`);
    }) as unknown as FetchLike;

    const provider = createRailwayProvider(fetchImpl);
    const result = await provider.provision({
      deploymentId: "deploy_abcdef123456",
      repoFullName: "demo-org/sample-app",
      prNumber: 42,
      commitSha: "abc123",
      allowedEnv: { PREVIEW: "true" },
    });

    expect(result.url).toBe("https://pr-42.up.railway.app");
    expect(result.providerRef).toBe("svc_123");
    expect(calls).toHaveLength(3);

    // Assert the exact commit SHA was sent, never omitted for a default-branch deploy
    const deployCall = calls.find((c: any) => c.query.includes("Deploy("));
    expect((deployCall as any).variables.commitSha).toBe("abc123");
  });

  it("provision(): surfaces a Railway API error clearly instead of returning a fake URL", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "Problem processing request" }] })
    ) as unknown as FetchLike;

    const provider = createRailwayProvider(fetchImpl);
    await expect(
      provider.provision({
        deploymentId: "d1",
        repoFullName: "demo-org/sample-app",
        prNumber: 1,
        commitSha: "abc",
        allowedEnv: {},
      })
    ).rejects.toThrow(/Problem processing request/);
  });

  it("update(): redeploys the same service at the new commit and reuses the existing domain", async () => {
    const calls: { query: string; variables: unknown }[] = [];
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push(body);
      if (body.query.includes("Deploy(")) return jsonResponse({ data: { serviceInstanceDeployV2: true } });
      if (body.query.includes("GetDomain")) {
        return jsonResponse({
          data: { service: { domains: { serviceDomains: [{ domain: "pr-42.up.railway.app" }] } } },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    }) as unknown as FetchLike;

    const provider = createRailwayProvider(fetchImpl);
    const result = await provider.update({ providerRef: "svc_123", commitSha: "def456" });

    expect(result.url).toBe("https://pr-42.up.railway.app");
    const deployCall = calls.find((c: any) => c.query.includes("Deploy("));
    expect((deployCall as any).variables.commitSha).toBe("def456");
  });

  it("teardown(): calls serviceDelete with the exact service id", async () => {
    let sentVariables: unknown;
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      sentVariables = JSON.parse((init as RequestInit).body as string).variables;
      return jsonResponse({ data: { serviceDelete: true } });
    }) as unknown as FetchLike;

    const provider = createRailwayProvider(fetchImpl);
    await provider.teardown("svc_123");

    expect(sentVariables).toEqual({ id: "svc_123" });
  });

  it("throws before making any network call if Railway credentials are missing", async () => {
    process.env.RAILWAY_API_TOKEN = "";
    const fetchImpl: FetchLike = vi.fn() as unknown as FetchLike;
    const provider = createRailwayProvider(fetchImpl);

    await expect(
      provider.provision({
        deploymentId: "d1",
        repoFullName: "x/y",
        prNumber: 1,
        commitSha: "abc",
        allowedEnv: {},
      })
    ).rejects.toThrow(/requires RAILWAY_API_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
