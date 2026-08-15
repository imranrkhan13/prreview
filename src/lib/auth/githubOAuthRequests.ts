/**
 * GitHub OAuth ("Sign in with GitHub") token exchange and profile fetch.
 * Same testability pattern as src/lib/railwayRequests.ts +
 * src/lib/railwayClient.ts: pure request/response shape functions here,
 * a thin injectable-fetch transport, both unit-tested against fixtures
 * matching GitHub's documented API shapes. NOT verified against GitHub's
 * live API from this environment — see githubOAuthClient.test.ts and the
 * README for the same "verified vs unverified" distinction already
 * established for Railway.
 *
 * Uses the GitHub App's own OAuth capability (Client ID / Client Secret
 * from the GitHub App settings, not a separate OAuth App) — one GitHub
 * App handles both "sign in with GitHub" and the installation/webhook
 * flow, per GitHub's supported pattern for Apps with "Request user
 * authorization (OAuth) during installation" enabled.
 */

export interface GitHubTokenExchangeResult {
  accessToken: string;
}

export interface GitHubUserProfile {
  githubUserId: number;
  login: string;
  avatarUrl: string | null;
}

export function buildAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function parseTokenExchangeResponse(data: unknown): GitHubTokenExchangeResult {
  const accessToken = (data as { access_token?: string })?.access_token;
  const error = (data as { error?: string; error_description?: string })?.error;
  if (error) {
    throw new Error(`GitHub OAuth error: ${error} - ${(data as { error_description?: string }).error_description ?? ""}`);
  }
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error(`Unexpected token exchange response shape: missing access_token`);
  }
  return { accessToken };
}

export function parseUserProfileResponse(data: unknown): GitHubUserProfile {
  const id = (data as { id?: number })?.id;
  const login = (data as { login?: string })?.login;
  const avatarUrl = (data as { avatar_url?: string })?.avatar_url;
  if (typeof id !== "number" || typeof login !== "string") {
    throw new Error(`Unexpected GitHub user profile response shape: ${JSON.stringify(data)}`);
  }
  return { githubUserId: id, login, avatarUrl: avatarUrl ?? null };
}
