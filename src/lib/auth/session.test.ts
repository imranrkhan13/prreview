import { describe, it, expect, vi } from "vitest";
import { createSessionToken, verifySessionToken } from "./session.js";

const secret = "test-session-secret";

describe("session tokens", () => {
  it("creates a token that verifies successfully", () => {
    const created = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const result = verifySessionToken(created.token, secret);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.userId).toBe("user_1");
      expect(result.payload.sid).toBe(created.sid);
    }
  });

  it("rejects a token signed with a different secret", () => {
    const created = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const result = verifySessionToken(created.token, "wrong-secret");
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload (userId swapped) even with a superficially valid shape", () => {
    const created = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const [payloadB64, sig] = created.token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ userId: "user_2", sid: "x", iat: 0, exp: 9999999999 }),
      "utf8"
    ).toString("base64url");
    const tamperedToken = `${tamperedPayload}.${sig}`;
    const result = verifySessionToken(tamperedToken, secret);
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a malformed token (no dot separator)", () => {
    expect(verifySessionToken("not-a-real-token", secret)).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects an expired token", () => {
    const created = createSessionToken({ userId: "user_1", secret, ttlSeconds: -10 }); // already expired
    const result = verifySessionToken(created.token, secret);
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("issues a fresh random sid for every token, so distinct sessions can be revoked independently", () => {
    const a = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    const b = createSessionToken({ userId: "user_1", secret, ttlSeconds: 3600 });
    expect(a.sid).not.toBe(b.sid);
  });
});
