import { describe, it, expect } from "vitest";
import { isValidRepoFullName, assertValidRepoFullName } from "./repoFullName.js";

describe("isValidRepoFullName", () => {
  it("accepts normal GitHub owner/repo names", () => {
    expect(isValidRepoFullName("demo-org/sample-app")).toBe(true);
    expect(isValidRepoFullName("acme_corp/my.repo-2")).toBe(true);
  });

  it("rejects values with no slash", () => {
    expect(isValidRepoFullName("not-a-repo-name")).toBe(false);
  });

  it("rejects values with shell/URL metacharacters", () => {
    expect(isValidRepoFullName("demo-org/sample-app; rm -rf /")).toBe(false);
    expect(isValidRepoFullName("demo-org/sample-app && curl evil.com")).toBe(false);
    expect(isValidRepoFullName("demo-org/../../etc/passwd")).toBe(false);
    expect(isValidRepoFullName("demo-org/repo?query=1")).toBe(false);
  });

  it("rejects empty segments", () => {
    expect(isValidRepoFullName("/sample-app")).toBe(false);
    expect(isValidRepoFullName("demo-org/")).toBe(false);
  });
});

describe("assertValidRepoFullName", () => {
  it("does not throw on a valid name", () => {
    expect(() => assertValidRepoFullName("demo-org/sample-app")).not.toThrow();
  });

  it("throws with a clear message on an invalid name", () => {
    expect(() => assertValidRepoFullName("bad name")).toThrow(/fails validation/);
  });
});
