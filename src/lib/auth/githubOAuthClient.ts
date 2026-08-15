import {
  buildAuthorizeUrl,
  parseTokenExchangeResponse,
  parseUserProfileResponse,
  GitHubTokenExchangeResult,
  GitHubUserProfile,
} from "./githubOAuthRequests.js";

export type FetchLike = typeof fetch;

export interface GitHubOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}

export function createGitHubOAuthClient(config: GitHubOAuthClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    getAuthorizeUrl(state: string): string {
      return buildAuthorizeUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state });
    },

    async exchangeCodeForToken(code: string): Promise<GitHubTokenExchangeResult> {
      const res = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
        }),
      });
      const data = await res.json();
      return parseTokenExchangeResponse(data);
    },

    async fetchUserProfile(accessToken: string): Promise<GitHubUserProfile> {
      const res = await fetchImpl("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "prpreview",
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub user profile fetch failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      return parseUserProfileResponse(data);
    },
  };
}

export type GitHubOAuthClient = ReturnType<typeof createGitHubOAuthClient>;
