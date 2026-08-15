import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Commit SHAs are always 7-40 hex characters. Validated here as a second
// layer even though execFile's argument-array form (never a shell string)
// already prevents command injection — a malformed SHA should fail loudly
// at the point of use, not silently reach `git checkout`.
const VALID_COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Clones a repo at a specific commit SHA into a scratch directory and runs
 * `docker build` against `.prpreview/Dockerfile` in that checkout. This is
 * the piece that makes LocalDockerProvider's containers reflect the actual
 * PR code rather than a placeholder image.
 *
 * Deliberately narrow contract: the target repo MUST provide
 * `.prpreview/Dockerfile` (documented in README under "Repo requirements").
 * If it's missing, this throws with a clear, actionable message rather than
 * silently building nothing.
 */
export async function buildPreviewImage(params: {
  cloneUrl: string;
  commitSha: string;
  imageTag: string;
}): Promise<void> {
  const { cloneUrl, commitSha, imageTag } = params;

  if (!VALID_COMMIT_SHA.test(commitSha)) {
    throw new Error(`Refusing to check out commit SHA that fails validation: ${JSON.stringify(commitSha)}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "prpreview-"));

  try {
    await execFileAsync("git", ["clone", "--no-checkout", cloneUrl, workDir]);
    await execFileAsync("git", ["-C", workDir, "checkout", commitSha]);

    const dockerfilePath = join(workDir, ".prpreview", "Dockerfile");
    const exists = await fileExists(dockerfilePath);
    if (!exists) {
      throw new Error(
        `No .prpreview/Dockerfile found at commit ${commitSha}. ` +
          `Target repos must provide one — see README "Repo requirements".`
      );
    }

    await execFileAsync("docker", [
      "build",
      "-f",
      dockerfilePath,
      "-t",
      imageTag,
      workDir,
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}
