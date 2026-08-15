import { useEffect, useState } from "react";
import { api, DeploymentEventRow, PrSummary } from "./api";
import { StatusPill } from "./StatusPill";

export function DeploymentDetail({
  pr,
  sessionToken,
  onApproved,
}: {
  pr: PrSummary;
  sessionToken: string;
  onApproved?: () => void;
}) {
  const [events, setEvents] = useState<DeploymentEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    if (!pr.deployment) return;
    let cancelled = false;
    setEvents(null);
    setError(null);
    api
      .getDeploymentEvents(sessionToken, pr.deployment.id)
      .then((rows) => !cancelled && setEvents(rows))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [pr.deployment?.id, sessionToken]);

  async function handleApprove() {
    setApproving(true);
    setApproveError(null);
    try {
      await api.approvePr(sessionToken, pr.id);
      onApproved?.();
    } catch (err) {
      setApproveError((err as Error).message);
    } finally {
      setApproving(false);
    }
  }

  if (pr.needsApproval) {
    return (
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>
          #{pr.number} — {pr.title}
        </h2>
        <div
          style={{
            background: "var(--status-provisioning-bg)",
            border: "1px solid var(--status-provisioning)",
            color: "var(--status-provisioning)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            fontSize: 13,
          }}
        >
          This PR comes from a fork (external contributor: <strong>{pr.author}</strong>).
          Its code hasn't run yet — approve it to deploy a public preview, or leave it
          pending if you don't recognize the contributor.
        </div>
        <button
          onClick={handleApprove}
          disabled={approving}
          style={{
            alignSelf: "flex-start",
            background: "var(--brand)",
            color: "#0b0e14",
            border: "none",
            borderRadius: 6,
            padding: "8px 14px",
            fontWeight: 600,
            cursor: approving ? "default" : "pointer",
            opacity: approving ? 0.6 : 1,
          }}
        >
          {approving ? "Approving…" : "Approve and deploy preview"}
        </button>
        {approveError && <div style={{ color: "var(--status-failed)", fontSize: 13 }}>{approveError}</div>}
      </div>
    );
  }

  if (!pr.deployment) {
    return (
      <div style={{ padding: 24, color: "var(--text-muted)" }}>
        No deployment has been queued for this PR yet.
      </div>
    );
  }

  const d = pr.deployment;

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>
          #{pr.number} — {pr.title}
        </h2>
        <StatusPill status={d.status} />
      </div>

      {d.demoMode && (
        <div
          style={{
            background: "var(--brand-dim)",
            color: "#c4d3ff",
            border: "1px solid var(--brand)",
            borderRadius: "var(--radius)",
            padding: "10px 14px",
            fontSize: 13,
          }}
        >
          Demo mode — this preview runs in a local Docker container on this machine, not a
          shareable public cloud URL. See "Demo vs live mode" in the README.
        </div>
      )}

      {!d.demoMode && d.status !== "LIVE" && d.status !== "STOPPED" && d.status !== "EXPIRED" && (
        <div
          style={{
            background: "var(--status-provisioning-bg)",
            border: "1px solid var(--status-provisioning)",
            color: "var(--status-provisioning)",
            borderRadius: "var(--radius)",
            padding: "10px 14px",
            fontSize: 13,
          }}
        >
          {d.status === "HEALTH_CHECK"
            ? `A deployment was created — confirming it's actually reachable before showing a link (attempt ${d.healthCheckAttempts || 1}).`
            : "A deployment has been requested. It isn't a working preview yet — this only becomes a shareable link once it passes a health check."}
        </div>
      )}

      <dl style={detailGridStyle}>
        <dt style={dtStyle}>Commit</dt>
        <dd style={ddStyle} className="mono">
          {d.commitSha.slice(0, 12)}
        </dd>

        <dt style={dtStyle}>URL</dt>
        <dd style={ddStyle}>
          {d.url ? (
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{
                display: "inline-block",
                background: "var(--status-live-bg)",
                color: "var(--status-live)",
                borderRadius: 4,
                padding: "3px 8px",
                textDecoration: "none",
              }}
            >
              Open preview ↗
            </a>
          ) : (
            <span style={{ color: "var(--text-faint)" }}>not yet available</span>
          )}
        </dd>

        <dt style={dtStyle}>Created</dt>
        <dd style={ddStyle}>{new Date(d.createdAt).toLocaleString()}</dd>

        <dt style={dtStyle}>Last updated</dt>
        <dd style={ddStyle}>{new Date(d.updatedAt).toLocaleString()}</dd>

        {d.expiresAt && (
          <>
            <dt style={dtStyle}>Expires</dt>
            <dd style={ddStyle}>{new Date(d.expiresAt).toLocaleString()}</dd>
          </>
        )}

        {d.lastHealthCheckAt && (
          <>
            <dt style={dtStyle}>Last health check</dt>
            <dd style={ddStyle}>
              {new Date(d.lastHealthCheckAt).toLocaleString()} ({d.healthCheckAttempts} attempt
              {d.healthCheckAttempts === 1 ? "" : "s"})
            </dd>
          </>
        )}

        {d.failureReason && (
          <>
            <dt style={dtStyle}>Failure reason</dt>
            <dd style={{ ...ddStyle, color: "var(--status-failed)" }}>{d.failureReason}</dd>
          </>
        )}
      </dl>

      <div>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)" }}>
          Events
        </h3>
        {error && <div style={{ color: "var(--status-failed)", fontSize: 13 }}>{error}</div>}
        {!events && !error && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading events…</div>}
        {events && events.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No events recorded yet.</div>
        )}
        {events && events.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              maxHeight: 280,
              overflowY: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            {events.map((e, i) => (
              <li
                key={i}
                style={{
                  padding: "6px 10px",
                  background: "var(--surface-raised)",
                  borderRadius: 4,
                  color: e.type === "error" ? "var(--status-failed)" : "var(--text)",
                }}
              >
                <span style={{ color: "var(--text-faint)" }}>
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>{" "}
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <LogsPanel sessionToken={sessionToken} deploymentId={d.id} status={d.status} />
    </div>
  );
}

function LogsPanel({ sessionToken, deploymentId, status }: { sessionToken: string; deploymentId: string; status: string }) {
  const [logs, setLogs] = useState<{ lines: string[]; note?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchLogs() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getDeploymentLogs(sessionToken, deploymentId);
      setLogs(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)", margin: 0 }}>
          Logs
        </h3>
        <button
          onClick={fetchLogs}
          disabled={loading}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            borderRadius: 4,
            padding: "4px 10px",
            fontSize: 12,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Loading…" : logs ? "Refresh" : "Load logs"}
        </button>
      </div>
      {status !== "LIVE" && status !== "UPDATING" && status !== "HEALTH_CHECK" && !logs && (
        <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
          Logs are only available while a deployment is running.
        </div>
      )}
      {error && <div style={{ color: "var(--status-failed)", fontSize: 13, marginTop: 6 }}>{error}</div>}
      {logs && (
        <>
          {logs.note && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6, marginBottom: 6 }}>{logs.note}</div>
          )}
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              background: "var(--surface-raised)",
              borderRadius: 6,
              padding: 10,
              maxHeight: 220,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              margin: 0,
            }}
          >
            {logs.lines.length > 0 ? logs.lines.join("\n") : "(no log output)"}
          </pre>
        </>
      )}
    </div>
  );
}

const detailGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  rowGap: 8,
  columnGap: 12,
  fontSize: 13,
  margin: 0,
};
const dtStyle: React.CSSProperties = { color: "var(--text-muted)" };
const ddStyle: React.CSSProperties = { margin: 0 };
