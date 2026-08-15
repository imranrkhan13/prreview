/**
 * Validates a GitHub `owner/repo` full name before it's used anywhere
 * that builds a URL or external command from it (git clone in
 * buildCheckout.ts, Railway's `source.repo` field in RailwayProvider).
 *
 * Defense in depth: `fullName` values in this system are always sourced
 * from GitHub webhook payloads (installation sync, PR events), not typed
 * in by an end user, and git/Docker calls already use execFile with
 * argument arrays (never a shell string), so there is no direct command-
 * injection path today. This check exists as a second layer — GitHub's
 * own naming rules are enforced here explicitly rather than assumed, so a
 * malformed value fails loudly at the point of use instead of silently
 * flowing into a URL.
 */
const VALID_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidRepoFullName(fullName: string): boolean {
  return VALID_FULL_NAME.test(fullName);
}

export function assertValidRepoFullName(fullName: string): void {
  if (!isValidRepoFullName(fullName)) {
    throw new Error(`Refusing to use repository full name that fails validation: ${JSON.stringify(fullName)}`);
  }
}
