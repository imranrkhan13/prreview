import type { DeploymentSummary } from "./api";

const STATUS_META: Record<
  DeploymentSummary["status"],
  { label: string; fg: string; bg: string; pulse?: boolean }
> = {
  QUEUED: { label: "Queued", fg: "var(--text-muted)", bg: "var(--surface-raised)" },
  PROVISIONING: {
    label: "Provisioning",
    fg: "var(--status-provisioning)",
    bg: "var(--status-provisioning-bg)",
    pulse: true,
  },
  DEPLOYING: {
    label: "Deploying",
    fg: "var(--status-provisioning)",
    bg: "var(--status-provisioning-bg)",
    pulse: true,
  },
  HEALTH_CHECK: {
    label: "Checking health",
    fg: "var(--status-provisioning)",
    bg: "var(--status-provisioning-bg)",
    pulse: true,
  },
  LIVE: { label: "Live", fg: "var(--status-live)", bg: "var(--status-live-bg)", pulse: true },
  UPDATING: {
    label: "Updating",
    fg: "var(--status-provisioning)",
    bg: "var(--status-provisioning-bg)",
    pulse: true,
  },
  FAILED: { label: "Failed", fg: "var(--status-failed)", bg: "var(--status-failed-bg)" },
  STOPPED: { label: "Stopped", fg: "var(--status-stopped)", bg: "var(--status-stopped-bg)" },
  EXPIRED: { label: "Expired", fg: "var(--status-stopped)", bg: "var(--status-stopped-bg)" },
};

export function StatusPill({ status }: { status: DeploymentSummary["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: meta.fg,
        background: meta.bg,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: meta.fg,
          animation: meta.pulse ? "pulse 1.6s ease-in-out infinite" : undefined,
        }}
      />
      {meta.label}
    </span>
  );
}
