import { describe, it, expect, vi } from "vitest";
import { createGitHubOAuthClient, FetchLike } from "./githubOAuthClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("GitHub OAuth client (via injected mock fetch — no live network)", () => {
  it("exchangeCodeForToken sends client_id/client_secret/code/redirect_uri and parses the token", async () => {
    let sentBody: unknown;
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string);
      return jsonResponse({ access_token: "gho_test123", token_type: "bearer" });
    }) as unknown as FetchLike;

    const client = createGitHubOAuthClient({
      clientId: "client_1",
      clientSecret: "secret_1",
      redirectUri: "https://RAILWAYAPIURL/api/auth/github/callback",
      fetchImpl,
    });

    const result = await client.exchangeCodeForToken("some-code");

    expect(result.accessToken).toBe("gho_test123");
    expect(sentBody).toMatchObject({
      client_id: "client_1",
      client_secret: "secret_1",
      code: "some-code",
      redirect_uri: "https://RAILWAYAPIURL/api/auth/github/callback",
    });
  });

  it("fetchUserProfile sends the bearer token and parses the profile", async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      sentHeaders = (init as RequestInit).headers as Record<string, string>;
      return jsonResponse({ id: 999, login: "test-user", avatar_url: "https://example.com/a.png" });
    }) as unknown as FetchLike;

    const client = createGitHubOAuthClient({
      clientId: "c",
      clientSecret: "s",
      redirectUri: "https://x",
      fetchImpl,
    });

    const profile = await client.fetchUserProfile("gho_test123");

    expect(profile).toEqual({ githubUserId: 999, login: "test-user", avatarUrl: "https://example.com/a.png" });
    expect(sentHeaders.Authorization).toBe("Bearer gho_test123");
  });

  it("fetchUserProfile throws clearly on a non-2xx response instead of parsing garbage", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response("", { status: 401 })) as unknown as FetchLike;
    const client = createGitHubOAuthClient({ clientId: "c", clientSecret: "s", redirectUri: "https://x", fetchImpl });
    await expect(client.fetchUserProfile("bad-token")).rejects.toThrow(/HTTP 401/);
  });

  it("exchangeCodeForToken surfaces a GitHub OAuth error clearly", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ error: "bad_verification_code", error_description: "expired" })
    ) as unknown as FetchLike;
    const client = createGitHubOAuthClient({ clientId: "c", clientSecret: "s", redirectUri: "https://x", fetchImpl });
    await expect(client.exchangeCodeForToken("stale-code")).rejects.toThrow(/bad_verification_code/);
  });
});
