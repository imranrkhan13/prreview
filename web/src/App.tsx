import { useEffect, useState, useCallback } from "react";
import {
  api,
  ApiError,
  getStoredSessionToken,
  storeSessionToken,
  clearStoredSessionToken,
  CurrentUser,
  PrSummary,
  RepoSummary,
} from "./api";
import { StatusPill } from "./StatusPill";
import { DeploymentDetail } from "./DeploymentDetail";
import { LandingPage } from "./landing/LandingPage";

export default function App() {
  // No router library -- this is the one path-based branch the app needs.
  if (window.location.pathname === "/auth/callback") {
    return <AuthCallback />;
  }

  const [sessionToken, setSessionToken] = useState<string | null>(getStoredSessionToken());

  if (!sessionToken) {
    return <LandingPage />;
  }

  return (
    <Dashboard
      sessionToken={sessionToken}
      onSignOut={() => {
        api.logout(sessionToken);
        clearStoredSessionToken();
        setSessionToken(null);
      }}
    />
  );
}

function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthError = params.get("error");

    if (oauthError) {
      setError("Sign-in with GitHub failed. Please try again.");
      return;
    }
    if (!code) {
      setError("Missing sign-in code. Please try again.");
      return;
    }

    api
      .exchangeCode(code)
      .then((result) => {
        storeSessionToken(result.token);
        window.location.replace("/"); // clears the code from the URL/history
      })
      .catch(() => setError("Sign-in failed or expired. Please try again."));
  }, []);

  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 24 }}>
      {error ? (
        <div style={{ textAlign: "center" }}>
          <div style={{ color: "var(--status-failed)", marginBottom: 16 }}>{error}</div>
          <a href="/" style={{ color: "var(--brand)" }}>
            Back to sign in
          </a>
        </div>
      ) : (
        <div style={{ color: "var(--text-muted)" }}>Signing you in…</div>
      )}
    </div>
  );
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; isNetworkError?: boolean }
  | { status: "ready"; data: T };

function Dashboard({ sessionToken, onSignOut }: { sessionToken: string; onSignOut: () => void }) {
  const [me, setMe] = useState<LoadState<CurrentUser>>({ status: "loading" });
  const [repos, setRepos] = useState<LoadState<RepoSummary[]>>({ status: "loading" });
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [prs, setPrs] = useState<LoadState<PrSummary[]>>({ status: "loading" });
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);
  const [togglingRepoId, setTogglingRepoId] = useState<string | null>(null);

  const handleAuthFailure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut();
        return true;
      }
      return false;
    },
    [onSignOut]
  );

  useEffect(() => {
    api.getMe(sessionToken).then(
      (data) => setMe({ status: "ready", data }),
      (err) => {
        if (!handleAuthFailure(err)) setMe({ status: "error", message: err.message });
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  const loadRepos = useCallback(() => {
    setRepos({ status: "loading" });
    api
      .getRepos(sessionToken)
      .then((data) => {
        setRepos({ status: "ready", data });
        setSelectedRepoId((prev) => prev ?? (data.length > 0 ? data[0].id : null));
      })
      .catch((err) => {
        if (handleAuthFailure(err)) return;
        const isNetworkError = err instanceof ApiError && err.isNetworkError;
        setRepos({ status: "error", message: err.message, isNetworkError });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const loadPrs = useCallback(
    (repoId: string) => {
      setPrs({ status: "loading" });
      setSelectedPrId(null);
      api
        .getPullRequests(sessionToken, repoId)
        .then((data) => {
          setPrs({ status: "ready", data });
          if (data.length > 0) setSelectedPrId(data[0].id);
        })
        .catch((err) => {
          if (handleAuthFailure(err)) return;
          const isNetworkError = err instanceof ApiError && err.isNetworkError;
          setPrs({ status: "error", message: err.message, isNetworkError });
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionToken]
  );

  useEffect(() => {
    if (selectedRepoId) loadPrs(selectedRepoId);
  }, [selectedRepoId, loadPrs]);

  async function handleToggleRepo(repo: RepoSummary) {
    setTogglingRepoId(repo.id);
    try {
      if (repo.allowed) {
        await api.disableRepository(sessionToken, repo.id);
      } else {
        await api.enableRepository(sessionToken, repo.id);
      }
      loadRepos();
    } catch (err) {
      if (!handleAuthFailure(err)) {
        // Non-fatal -- surface inline rather than blowing up the sidebar
        console.error("Failed to toggle repo previews:", err);
      }
    } finally {
      setTogglingRepoId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16 }}>prpreview</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {me.status === "ready" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)" }}>
              {me.data.avatarUrl && (
                <img
                  src={me.data.avatarUrl}
                  alt=""
                  style={{ width: 22, height: 22, borderRadius: "50%" }}
                />
              )}
              {me.data.login}
            </div>
          )}
          <button
            onClick={onSignOut}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
        <aside
          style={{
            width: 240,
            minWidth: 200,
            borderRight: "1px solid var(--border)",
            padding: 16,
            overflowY: "auto",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Repositories
          </div>
          {repos.status === "loading" && <SkeletonLines count={3} />}
          {repos.status === "error" && <ErrorNote message={repos.message} onRetry={loadRepos} />}
          {repos.status === "ready" && repos.data.length === 0 && (
            <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
              No repositories yet. Install the GitHub App and select repositories to enable previews for.
            </div>
          )}
          {repos.status === "ready" &&
            repos.data.map((r) => (
              <div
                key={r.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: 6,
                  marginBottom: 4,
                  background: r.id === selectedRepoId ? "var(--surface-raised)" : "transparent",
                }}
              >
                <button
                  onClick={() => setSelectedRepoId(r.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "var(--text)",
                    fontSize: 13,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {r.fullName}
                </button>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                  <span
                    style={{
                      fontSize: 11,
                      color: r.allowed ? "var(--status-live)" : "var(--text-faint)",
                    }}
                  >
                    Preview deployments: {r.allowed ? "Enabled" : "Disabled"}
                  </span>
                  <button
                    onClick={() => handleToggleRepo(r)}
                    disabled={togglingRepoId === r.id}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                      borderRadius: 4,
                      padding: "2px 8px",
                      fontSize: 11,
                      cursor: togglingRepoId === r.id ? "default" : "pointer",
                    }}
                  >
                    {togglingRepoId === r.id ? "…" : r.allowed ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>
            ))}
        </aside>

        <main style={{ flex: "2 1 420px", minWidth: 320, borderRight: "1px solid var(--border)", overflowY: "auto" }}>
          {prs.status === "loading" && (
            <div style={{ padding: 20 }}>
              <SkeletonLines count={4} />
            </div>
          )}
          {prs.status === "error" && (
            <div style={{ padding: 20 }}>
              <ErrorNote message={prs.message} onRetry={() => selectedRepoId && loadPrs(selectedRepoId)} />
            </div>
          )}
          {prs.status === "ready" && prs.data.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
              <div style={{ fontSize: 15, marginBottom: 6, color: "var(--text)" }}>No pull requests yet</div>
              <div style={{ fontSize: 13 }}>
                Open a pull request on this repository and a preview will be queued automatically once
                GitHub sends the webhook.
              </div>
            </div>
          )}
          {prs.status === "ready" && prs.data.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["PR", "Status", "Commit", "Updated"].map((h) => (
                    <th
                      key={h}
                      style={{ textAlign: "left", padding: "10px 16px", color: "var(--text-muted)", fontWeight: 500, fontSize: 12 }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prs.data.map((pr) => (
                  <tr
                    key={pr.id}
                    onClick={() => setSelectedPrId(pr.id)}
                    style={{
                      cursor: "pointer",
                      background: pr.id === selectedPrId ? "var(--surface-raised)" : "transparent",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <td style={{ padding: "10px 16px" }}>
                      <div style={{ fontWeight: 500 }}>
                        #{pr.number} {pr.title}
                      </div>
                      <div style={{ color: "var(--text-faint)", fontSize: 12 }}>by {pr.author}</div>
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      {pr.needsApproval ? (
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--status-provisioning)",
                            background: "var(--status-provisioning-bg)",
                            padding: "3px 10px",
                            borderRadius: 999,
                          }}
                        >
                          Needs approval
                        </span>
                      ) : pr.deployment ? (
                        <StatusPill status={pr.deployment.status} />
                      ) : (
                        <span style={{ color: "var(--text-faint)" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px" }} className="mono">
                      {pr.deployment?.commitSha.slice(0, 8) ?? "—"}
                    </td>
                    <td style={{ padding: "10px 16px", color: "var(--text-muted)" }}>
                      {new Date(pr.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </main>

        <section style={{ flex: "1 1 320px", minWidth: 300, overflowY: "auto" }}>
          {prs.status === "ready" && selectedPrId && (
            <DeploymentDetail
              pr={prs.data.find((p) => p.id === selectedPrId)!}
              sessionToken={sessionToken}
              onApproved={() => {
                if (selectedRepoId) loadPrs(selectedRepoId);
              }}
            />
          )}
          {(!selectedPrId || prs.status !== "ready") && (
            <div style={{ padding: 40, color: "var(--text-faint)", fontSize: 13 }}>
              Select a pull request to see its preview details.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SkeletonLines({ count }: { count: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            borderRadius: 4,
            background: "var(--surface-raised)",
            animation: "pulse 1.4s ease-in-out infinite",
            width: `${70 - i * 8}%`,
          }}
        />
      ))}
    </div>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        color: "var(--status-failed)",
        background: "var(--status-failed-bg)",
        borderRadius: 6,
        padding: "10px 12px",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <span>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            background: "transparent",
            border: "1px solid var(--status-failed)",
            color: "var(--status-failed)",
            borderRadius: 4,
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}
