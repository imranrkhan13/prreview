import { describe, it, expect } from "vitest";
import { parseInstallationEvent, parseInstallationRepositoriesEvent, decideInstallationAction } from "./installationEvents.js";

describe("parseInstallationEvent", () => {
  it("extracts org id, name, installation id, initial repos, and the installer from a 'created' payload", () => {
    const payload = {
      action: "created",
      installation: { id: 5001, account: { id: 9001, login: "demo-org" } },
      repositories: [
        { id: 111, full_name: "demo-org/sample-app" },
        { id: 222, full_name: "demo-org/other-app" },
      ],
      sender: { id: 7001, login: "imranrkhan13", avatar_url: "https://avatars.githubusercontent.com/u/7001" },
    };
    const parsed = parseInstallationEvent(payload);
    expect(parsed).toEqual({
      action: "created",
      installationId: 5001,
      githubOrgId: 9001,
      orgName: "demo-org",
      repositories: [
        { githubRepoId: 111, fullName: "demo-org/sample-app" },
        { githubRepoId: 222, fullName: "demo-org/other-app" },
      ],
      sender: { githubUserId: 7001, login: "imranrkhan13", avatarUrl: "https://avatars.githubusercontent.com/u/7001" },
    });
  });

  it("handles a 'deleted' payload with no repositories array", () => {
    const payload = {
      action: "deleted",
      installation: { id: 5001, account: { id: 9001, login: "demo-org" } },
      sender: { id: 7001, login: "imranrkhan13" },
    };
    const parsed = parseInstallationEvent(payload);
    expect(parsed.repositories).toEqual([]);
    expect(parsed.action).toBe("deleted");
  });

  it("uses the GitHub-assigned numeric account id, not the org name, as the identity key", () => {
    // This is the property that matters for security: two different orgs
    // could theoretically share a similar login string, but never the
    // same numeric id — downstream code must use githubOrgId, not orgName.
    const payload = {
      action: "created",
      installation: { id: 1, account: { id: 42, login: "some-org" } },
      repositories: [],
      sender: { id: 1, login: "installer" },
    };
    const parsed = parseInstallationEvent(payload);
    expect(parsed.githubOrgId).toBe(42);
    expect(typeof parsed.githubOrgId).toBe("number");
  });

  it("tolerates a missing sender avatar_url", () => {
    const payload = {
      action: "created",
      installation: { id: 1, account: { id: 42, login: "some-org" } },
      repositories: [],
      sender: { id: 1, login: "installer" },
    };
    expect(parseInstallationEvent(payload).sender.avatarUrl).toBeNull();
  });
});

describe("parseInstallationRepositoriesEvent", () => {
  it("extracts added and removed repos separately", () => {
    const payload = {
      action: "added",
      installation: { id: 5001, account: { id: 9001, login: "demo-org" } },
      repositories_added: [{ id: 333, full_name: "demo-org/new-app" }],
      repositories_removed: [],
    };
    const parsed = parseInstallationRepositoriesEvent(payload);
    expect(parsed.repositoriesAdded).toEqual([{ githubRepoId: 333, fullName: "demo-org/new-app" }]);
    expect(parsed.repositoriesRemoved).toEqual([]);
  });

  it("extracts removed repos on a 'removed' action", () => {
    const payload = {
      action: "removed",
      installation: { id: 5001, account: { id: 9001, login: "demo-org" } },
      repositories_added: [],
      repositories_removed: [{ id: 111, full_name: "demo-org/sample-app" }],
    };
    const parsed = parseInstallationRepositoriesEvent(payload);
    expect(parsed.repositoriesRemoved).toEqual([{ githubRepoId: 111, fullName: "demo-org/sample-app" }]);
  });
});

describe("decideInstallationAction", () => {
  it("routes 'created' to sync_org_and_repos", () => {
    expect(decideInstallationAction("created")).toEqual({ kind: "sync_org_and_repos" });
  });

  it("routes 'deleted' to disable_all_repos", () => {
    const result = decideInstallationAction("deleted");
    expect(result.kind).toBe("disable_all_repos");
  });

  it("routes 'suspend' to disable_all_repos", () => {
    const result = decideInstallationAction("suspend");
    expect(result.kind).toBe("disable_all_repos");
  });

  it("routes 'unsuspend' to a no-op that does NOT re-enable repos", () => {
    // This is the deliberate security choice documented in webhook.ts:
    // unsuspending the GitHub App must never silently reactivate preview
    // deployments without a human explicitly re-enabling each repo.
    const result = decideInstallationAction("unsuspend");
    expect(result.kind).toBe("noop_repos_stay_disabled");
  });

  it("routes an unrecognized action to unhandled, not silently to a mutating action", () => {
    expect(decideInstallationAction("new_permissions_accepted")).toEqual({ kind: "unhandled" });
  });
});
