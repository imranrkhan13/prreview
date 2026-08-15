// API client for the dashboard. Every request goes to the Railway backend
// via VITE_API_URL — NEVER a relative path like fetch("/api/repos"), which
// would incorrectly hit the Vercel frontend's own origin instead of the
// API. See buildApiUrl below.

const API_BASE_URL = (import.meta.env.VITE_API_URL || "http://localhost:3000").replace(/\/+$/, "");

export function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

/** Where the browser is sent to start "Continue with GitHub". A normal top-level navigation, not a fetch. */
export function githubLoginUrl(): string {
  return buildApiUrl("/api/auth/github/login");
}

export interface CurrentUser {
  id: string;
  login: string;
  avatarUrl: string | null;
  organizations: { id: string; name: string; role: string }[];
}

export interface OrgSummary {
  id: string;
  name: string;
}

export interface RepoSummary {
  id: string;
  orgId: string;
  fullName: string;
  allowed: boolean;
  createdAt: string;
}

export interface DeploymentSummary {
  id: string;
  status:
    | "QUEUED"
    | "PROVISIONING"
    | "DEPLOYING"
    | "HEALTH_CHECK"
    | "LIVE"
    | "UPDATING"
    | "FAILED"
    | "STOPPED"
    | "EXPIRED";
  url: string | null;
  commitSha: string;
  demoMode: boolean;
  failureReason: string | null;
  healthCheckAttempts: number;
  lastHealthCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface PrSummary {
  id: string;
  number: number;
  title: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isFork: boolean;
  needsApproval: boolean;
  createdAt: string;
  updatedAt: string;
  deployment: DeploymentSummary | null;
}

export interface DeploymentEventRow {
  type: string;
  message: string;
  createdAt: string;
}

export interface DeploymentLogsResult {
  lines: string[];
  note?: string;
}

const SESSION_TOKEN_STORAGE_KEY = "prpreview_session_token";

// Kept in sessionStorage only — tab-scoped, cleared on tab close, never
// localStorage, never a cookie (the dashboard and API are different
// origins; a bearer header avoids cross-site cookie complications
// entirely). See README "Authentication architecture".
export function getStoredSessionToken(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeSessionToken(token: string): void {
  try {
    window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } catch {
    // sessionStorage unavailable — token just won't persist across reloads
  }
}

export function clearStoredSessionToken(): void {
  try {
    window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    // no-op
  }
}

export class ApiError extends Error {
  status: number;
  /** True for network-level failures (offline, DNS, CORS block) vs. a real HTTP error response. */
  isNetworkError: boolean;
  constructor(status: number, message: string, isNetworkError = false) {
    super(message);
    this.status = status;
    this.isNetworkError = isNetworkError;
  }
}

async function request<T>(path: string, sessionToken: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildApiUrl(path), {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    // fetch() throws on network failure, DNS failure, or a CORS block —
    // all of which look identical from here. Surface a distinct, honest
    // error rather than pretending it's a normal HTTP failure.
    throw new ApiError(
      0,
      "Could not reach the API. Check your connection, or that the API server is running and CORS allows this origin.",
      true
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  /** Exchanges the one-time OAuth callback code for a real session token. No auth header needed for this call itself. */
  exchangeCode: async (code: string): Promise<{ token: string; expiresAt: string }> => {
    const res = await fetch(buildApiUrl("/api/auth/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code }),
    }).catch(() => {
      throw new ApiError(0, "Could not reach the API to complete sign-in.", true);
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? "Sign-in failed");
    }
    return res.json();
  },

  logout: async (sessionToken: string): Promise<void> => {
    await fetch(buildApiUrl("/api/auth/logout"), {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}` },
    }).catch(() => undefined); // logout is best-effort client-side regardless
  },

  getMe: (sessionToken: string) => request<CurrentUser>("/api/me", sessionToken),

  getOrganizations: (sessionToken: string) => request<OrgSummary[]>("/api/organizations", sessionToken),

  getRepos: (sessionToken: string) => request<RepoSummary[]>("/api/repos", sessionToken),

  getPullRequests: (sessionToken: string, repoId: string) =>
    request<PrSummary[]>(`/api/repos/${encodeURIComponent(repoId)}/prs`, sessionToken),

  getDeploymentEvents: (sessionToken: string, deploymentId: string) =>
    request<DeploymentEventRow[]>(`/api/deployments/${encodeURIComponent(deploymentId)}/events`, sessionToken),

  getDeploymentLogs: (sessionToken: string, deploymentId: string) =>
    request<DeploymentLogsResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/logs`, sessionToken),

  approvePr: (sessionToken: string, prId: string) =>
    request<{ id: string; status: string }>(`/api/prs/${encodeURIComponent(prId)}/approve`, sessionToken, {
      method: "POST",
    }),

  enableRepository: (sessionToken: string, repoId: string) =>
    request<{ id: string; allowed: boolean }>(`/api/repos/${encodeURIComponent(repoId)}/enable`, sessionToken, {
      method: "POST",
    }),

  disableRepository: (sessionToken: string, repoId: string) =>
    request<{ id: string; allowed: boolean }>(`/api/repos/${encodeURIComponent(repoId)}/disable`, sessionToken, {
      method: "POST",
    }),
};
