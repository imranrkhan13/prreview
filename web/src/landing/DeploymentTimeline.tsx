import { useEffect, useRef, useState } from "react";

/**
 * The signature visual for the landing page: a real render of prpreview's
 * actual deployment state machine (QUEUED -> PROVISIONING -> DEPLOYING ->
 * HEALTH_CHECK -> LIVE), auto-advancing to show the real workflow rather
 * than a generic product screenshot. Colors and labels intentionally
 * mirror StatusPill.tsx so this never drifts from what the dashboard
 * itself actually shows.
 */

const STEPS = [
  { key: "QUEUED", label: "Queued" },
  { key: "PROVISIONING", label: "Provisioning" },
  { key: "DEPLOYING", label: "Deploying" },
  { key: "HEALTH_CHECK", label: "Health check" },
  { key: "LIVE", label: "Live" },
] as const;

const STEP_DURATION_MS = 1400;
const HOLD_ON_LIVE_MS = 3200;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = () => setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

export interface DeploymentTimelineProps {
  prNumber: number;
  branch: string;
  commitSha: string;
  previewSlug: string;
  /** If true, cycles through states automatically. If false (or reduced motion is on), stays on LIVE. */
  animate?: boolean;
}

export function DeploymentTimeline({
  prNumber,
  branch,
  commitSha,
  previewSlug,
  animate = true,
}: DeploymentTimelineProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animate && !prefersReducedMotion;
  const [stepIndex, setStepIndex] = useState(shouldAnimate ? 0 : STEPS.length - 1);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!shouldAnimate) return;

    function advance(current: number) {
      const isLive = current === STEPS.length - 1;
      const delay = isLive ? HOLD_ON_LIVE_MS : STEP_DURATION_MS;
      timeoutRef.current = setTimeout(() => {
        setStepIndex((prev) => (prev + 1) % STEPS.length);
      }, delay);
    }

    advance(stepIndex);
    return () => clearTimeout(timeoutRef.current);
  }, [stepIndex, shouldAnimate]);

  const current = STEPS[stepIndex];
  const isLive = current.key === "LIVE";

  return (
    <div className="deploy-timeline" role="img" aria-label={`Deployment lifecycle demo, currently showing status: ${current.label}`}>
      <div className="deploy-timeline__header">
        <span className="deploy-timeline__dot" aria-hidden="true" />
        <span className="mono deploy-timeline__title">GitHub PR #{prNumber}</span>
      </div>
      <div className="deploy-timeline__meta mono">
        <span>{branch}</span>
        <span className="deploy-timeline__sep">·</span>
        <span>{commitSha}</span>
      </div>

      <ol className="deploy-timeline__steps">
        {STEPS.map((step, i) => {
          const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
          return (
            <li key={step.key} className={`deploy-timeline__step deploy-timeline__step--${state}`}>
              <span className="deploy-timeline__step-dot" aria-hidden="true" />
              <span className="deploy-timeline__step-label">{step.label}</span>
              {i < STEPS.length - 1 && <span className="deploy-timeline__connector" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div className={`deploy-timeline__url-row ${isLive ? "deploy-timeline__url-row--visible" : ""}`}>
        {isLive ? (
          <span className="mono deploy-timeline__url">
            <span className="deploy-timeline__live-dot" aria-hidden="true" />
            https://{previewSlug}.up.railway.app
          </span>
        ) : (
          <span className="mono deploy-timeline__url deploy-timeline__url--placeholder">awaiting preview URL…</span>
        )}
      </div>
    </div>
  );
}
