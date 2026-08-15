export interface HealthCheckResult {
  healthy: boolean;
  attempts: number;
  reason?: string;
}

export interface HealthCheckOptions {
  /** Total time budget before giving up and marking FAILED. */
  timeoutMs: number;
  /** Delay between poll attempts. */
  intervalMs: number;
  /** Belt-and-braces cap: stop even if time budget remains, once this many attempts have been made. */
  maxAttempts?: number;
  /** Path to request, relative to the base URL. Defaults to "/". */
  path?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests, so timeouts don't make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `url` until it returns any HTTP response (2xx-5xx all count as
 * "the app is up and answering" — a 404 still proves the process is
 * listening; a connection refusal/timeout does not). This is deliberately
 * a basic reachability check, not a deep app-level health check, because
 * prpreview doesn't control what the target app exposes. Repos can layer
 * a real `/healthz` via the `path` option once that convention exists.
 *
 * This is the ONLY thing that gates a deployment's status moving to LIVE.
 * A Railway service existing, or a Docker container starting, is NOT
 * sufficient on its own — this function is what proves the URL is
 * actually reachable before anyone is shown it.
 */
export async function pollUntilHealthy(
  url: string,
  options: HealthCheckOptions
): Promise<HealthCheckResult> {
  const { timeoutMs, intervalMs, maxAttempts, path = "/", fetchImpl = fetch, sleep = defaultSleep } = options;
  const target = new URL(path, url).toString();
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: string | undefined;

  while (Date.now() < deadline && (maxAttempts === undefined || attempts < maxAttempts)) {
    attempts++;
    try {
      await fetchImpl(target, { method: "GET" });
      // Any response at all (even an error status) proves the process is
      // up and listening on that port — that's what "reachable" means here.
      return { healthy: true, attempts };
    } catch (err) {
      lastError = (err as Error).message;
    }
    await sleep(intervalMs);
  }

  return {
    healthy: false,
    attempts,
    reason: `Health check timed out after ${timeoutMs}ms (${attempts} attempts). ${
      lastError ? `Last error: ${lastError}` : "No response was ever received."
    }`,
  };
}
