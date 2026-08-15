import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildApiUrl, githubLoginUrl, api, ApiError } from "./api.js";

describe("buildApiUrl", () => {
  it("prefixes paths with VITE_API_URL, never leaving them relative", () => {
    // import.meta.env.VITE_API_URL is read at module load in this test
    // environment's default (unset) config, which falls back to
    // http://localhost:3000 — the important assertion is that the result
    // is always an ABSOLUTE url, never a bare "/api/..." path that would
    // resolve against whatever origin the page happens to be served from.
    const url = buildApiUrl("/api/repos");
    expect(url.startsWith("http")).toBe(true);
    expect(url.endsWith("/api/repos")).toBe(true);
  });

  it("normalizes a path missing its leading slash", () => {
    const url = buildApiUrl("api/repos");
    expect(url).toMatch(/\/api\/repos$/);
  });

  it("never produces a double slash between base and path", () => {
    const url = buildApiUrl("/api/repos");
    expect(url).not.toMatch(/[^:]\/\//);
  });
});

describe("api client error classification", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("surfaces a 401 as an ApiError with status 401, not a generic throw", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 })
    );

    await expect(api.getRepos("bad-key")).rejects.toMatchObject({ status: 401 });
  });

  it("classifies a network failure (fetch throws) distinctly from an HTTP error response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("Failed to fetch"));

    try {
      await api.getRepos("some-key");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).isNetworkError).toBe(true);
      expect((err as ApiError).status).toBe(0);
    }
  });

  it("sends the Authorization: Bearer header and Accept: application/json on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    global.fetch = fetchMock;

    await api.getRepos("session-token-123");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/repos"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-token-123",
          Accept: "application/json",
        }),
      })
    );
  });

  it("URL-encodes dynamic IDs in the path (prevents path injection via a crafted id)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    global.fetch = fetchMock;

    await api.getPullRequests("key", "repo id/with slash");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("repo id/with slash"));
    expect(calledUrl).not.toContain("repo id/with slash");
  });
});

describe("githubLoginUrl", () => {
  it("points at the API's OAuth login endpoint, not a relative path", () => {
    const url = githubLoginUrl();
    expect(url.startsWith("http")).toBe(true);
    expect(url.endsWith("/api/auth/github/login")).toBe(true);
  });
});

describe("api.exchangeCode", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the one-time code with no auth header (none exists yet at this point)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: "session-abc", expiresAt: "2026-01-01T00:00:00Z" }), { status: 200 })
      );
    global.fetch = fetchMock;

    const result = await api.exchangeCode("one-time-code-xyz");

    expect(result.token).toBe("session-abc");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ code: "one-time-code-xyz" });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("throws ApiError on an invalid/expired code", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Exchange code is invalid, expired, or already used" }), { status: 401 })
      );
    await expect(api.exchangeCode("stale-code")).rejects.toMatchObject({ status: 401 });
  });
});

describe("api.logout", () => {
  it("sends the session token and never throws even if the request fails (best-effort)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));
    await expect(api.logout("session-abc")).resolves.toBeUndefined();
  });
});
