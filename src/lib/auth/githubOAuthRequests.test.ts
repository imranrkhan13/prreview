import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, parseTokenExchangeResponse, parseUserProfileResponse } from "./githubOAuthRequests.js";

describe("buildAuthorizeUrl", () => {
  it("builds a GitHub authorize URL with client_id, redirect_uri, and state", () => {
    const url = buildAuthorizeUrl({
      clientId: "Iv1.abc123",
      redirectUri: "https://RAILWAYAPIURL/api/auth/github/callback",
      state: "signed-state-value",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("Iv1.abc123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://RAILWAYAPIURL/api/auth/github/callback");
    expect(parsed.searchParams.get("state")).toBe("signed-state-value");
  });
});

describe("parseTokenExchangeResponse", () => {
  it("parses a successful token exchange (matches GitHub's documented shape)", () => {
    const fixture = { access_token: "gho_abc123", token_type: "bearer", scope: "" };
    expect(parseTokenExchangeResponse(fixture)).toEqual({ accessToken: "gho_abc123" });
  });

  it("throws a clear error on a GitHub-reported OAuth error (e.g. bad_verification_code)", () => {
    const fixture = { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." };
    expect(() => parseTokenExchangeResponse(fixture)).toThrow(/bad_verification_code/);
  });

  it("throws on an unexpected shape rather than returning an empty token", () => {
    expect(() => parseTokenExchangeResponse({ unexpected: true })).toThrow(/missing access_token/);
  });
});

describe("parseUserProfileResponse", () => {
  it("parses a GitHub user profile (matches the documented /user response shape)", () => {
    const fixture = { id: 12345, login: "imranrkhan13", avatar_url: "https://avatars.githubusercontent.com/u/12345" };
    expect(parseUserProfileResponse(fixture)).toEqual({
      githubUserId: 12345,
      login: "imranrkhan13",
      avatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
  });

  it("tolerates a missing avatar_url", () => {
    const fixture = { id: 12345, login: "imranrkhan13" };
    expect(parseUserProfileResponse(fixture).avatarUrl).toBeNull();
  });

  it("throws on a response missing id or login", () => {
    expect(() => parseUserProfileResponse({ login: "x" })).toThrow(/Unexpected GitHub user profile/);
    expect(() => parseUserProfileResponse({ id: 1 })).toThrow(/Unexpected GitHub user profile/);
  });
});
