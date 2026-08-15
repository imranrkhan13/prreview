/**
 * Pure parsing of GitHub App `installation` and `installation_repositories`
 * webhook payloads. Kept separate from the DB-touching handler in
 * webhook.ts so the "what does this payload mean" logic is unit-testable
 * without a live database — see installationEvents.test.ts.
 *
 * Security note this module enforces structurally: every value used to
 * identify an org or repo downstream is a GitHub-assigned numeric ID
 * (installation.account.id, repository.id), never a client-suppliable
 * string like a repo name. Full names are stored for display only.
 */

export interface InstallationRepoRef {
  githubRepoId: number;
  fullName: string;
}

export interface InstallationSender {
  githubUserId: number;
  login: string;
  avatarUrl: string | null;
}

export interface ParsedInstallationEvent {
  action: string;
  installationId: number;
  githubOrgId: number;
  orgName: string;
  /** Repos included at install time (only present on action === "created"). */
  repositories: InstallationRepoRef[];
  /** The GitHub user who performed this action (installer, suspender, etc). */
  sender: InstallationSender;
}

export interface ParsedInstallationRepositoriesEvent {
  action: "added" | "removed" | string;
  installationId: number;
  githubOrgId: number;
  orgName: string;
  repositoriesAdded: InstallationRepoRef[];
  repositoriesRemoved: InstallationRepoRef[];
}

interface RawInstallationPayload {
  action: string;
  installation: {
    id: number;
    account: { id: number; login: string };
  };
  repositories?: { id: number; full_name: string }[];
  sender: { id: number; login: string; avatar_url?: string };
}

interface RawInstallationRepositoriesPayload {
  action: string;
  installation: {
    id: number;
    account: { id: number; login: string };
  };
  repositories_added?: { id: number; full_name: string }[];
  repositories_removed?: { id: number; full_name: string }[];
}

function toRepoRefs(repos: { id: number; full_name: string }[] | undefined): InstallationRepoRef[] {
  return (repos ?? []).map((r) => ({ githubRepoId: r.id, fullName: r.full_name }));
}

export function parseInstallationEvent(payload: RawInstallationPayload): ParsedInstallationEvent {
  return {
    action: payload.action,
    installationId: payload.installation.id,
    githubOrgId: payload.installation.account.id,
    orgName: payload.installation.account.login,
    repositories: toRepoRefs(payload.repositories),
    sender: {
      githubUserId: payload.sender.id,
      login: payload.sender.login,
      avatarUrl: payload.sender.avatar_url ?? null,
    },
  };
}

export function parseInstallationRepositoriesEvent(
  payload: RawInstallationRepositoriesPayload
): ParsedInstallationRepositoriesEvent {
  return {
    action: payload.action,
    installationId: payload.installation.id,
    githubOrgId: payload.installation.account.id,
    orgName: payload.installation.account.login,
    repositoriesAdded: toRepoRefs(payload.repositories_added),
    repositoriesRemoved: toRepoRefs(payload.repositories_removed),
  };
}

export type InstallationActionDecision =
  | { kind: "disable_all_repos"; reason: string }
  | { kind: "noop_repos_stay_disabled"; reason: string }
  | { kind: "sync_org_and_repos" }
  | { kind: "unhandled" };

/**
 * Pure routing decision for an `installation` webhook action -- extracted
 * so the mapping itself (which actions disable vs sync vs no-op) is
 * unit-testable without a database. The DB-touching handler in
 * webhook.ts calls this and then executes the decision.
 */
export function decideInstallationAction(action: string): InstallationActionDecision {
  if (action === "deleted") {
    return { kind: "disable_all_repos", reason: "GitHub App uninstalled" };
  }
  if (action === "suspend") {
    return { kind: "disable_all_repos", reason: "GitHub App suspended" };
  }
  if (action === "unsuspend") {
    // Deliberately does NOT re-enable -- see webhook.ts docstring for why.
    return { kind: "noop_repos_stay_disabled", reason: "GitHub App unsuspended" };
  }
  if (action === "created") {
    return { kind: "sync_org_and_repos" };
  }
  return { kind: "unhandled" };
}
