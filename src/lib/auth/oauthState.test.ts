import { describe, it, expect, vi } from "vitest";
import { createOAuthState, verifyOAuthState } from "./oauthState.js";

const secret = "test-oauth-secret";

describe("OAuth state param (CSRF protection)", () => {
  it("verifies a state it just created", () => {
    const state = createOAuthState(secret);
    expect(verifyOAuthState(state, secret)).toBe(true);
  });

  it("rejects a state signed with a different secret", () => {
    const state = createOAuthState(secret);
    expect(verifyOAuthState(state, "wrong-secret")).toBe(false);
  });

  it("rejects a tampered state", () => {
    const state = createOAuthState(secret);
    const [nonce, exp, sig] = state.split(".");
    const tampered = `${nonce}different.${exp}.${sig}`;
    expect(verifyOAuthState(tampered, secret)).toBe(false);
  });

  it("rejects a malformed state (wrong number of segments)", () => {
    expect(verifyOAuthState("only.two", secret)).toBe(false);
    expect(verifyOAuthState("not-a-state-at-all", secret)).toBe(false);
  });

  it("rejects an expired state", () => {
    vi.useFakeTimers();
    const state = createOAuthState(secret);
    vi.advanceTimersByTime(10 * 60 * 1000); // 10 minutes, past the 5-minute TTL
    expect(verifyOAuthState(state, secret)).toBe(false);
    vi.useRealTimers();
  });

  it("generates a different state on every call (prevents replay across login attempts)", () => {
    expect(createOAuthState(secret)).not.toBe(createOAuthState(secret));
  });
});
