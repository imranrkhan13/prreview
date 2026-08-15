import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Session tokens are stateless, HMAC-signed bearer tokens — the same
 * signing pattern already used for GitHub webhook verification, applied
 * here to first-party session auth instead of a third party's payload.
 *
 * Payload: { userId, sid, iat, exp }. `sid` is a random per-session id,
 * used only so logout can revoke this ONE session (via RevokedSession)
 * without needing to track/verify every token server-side.
 *
 * Stored client-side in sessionStorage (tab-scoped, cleared on tab close),
 * sent as `Authorization: Bearer <token>` — deliberately NOT a cookie,
 * since the dashboard (Vercel) and API (Railway) are different origins
 * and a bearer header avoids third-party-cookie / SameSite complications
 * entirely. See README "Authentication architecture" for the full
 * rationale.
 */

export interface SessionPayload {
  userId: string;
  sid: string;
  iat: number; // issued-at, unix seconds
  exp: number; // expiry, unix seconds
}

export type SessionVerifyResult =
  | { valid: true; payload: SessionPayload }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function createSessionToken(params: { userId: string; secret: string; ttlSeconds: number }): SessionPayload & { token: string } {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    userId: params.userId,
    sid: randomBytes(16).toString("hex"),
    iat: now,
    exp: now + params.ttlSeconds,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64, params.secret);
  return { ...payload, token: `${payloadB64}.${signature}` };
}

export function verifySessionToken(token: string, secret: string): SessionVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [payloadB64, providedSignature] = parts;
  if (!payloadB64 || !providedSignature) return { valid: false, reason: "malformed" };

  const expectedSignature = sign(payloadB64, secret);
  const providedBuf = Buffer.from(providedSignature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: "bad_signature" };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (
    typeof payload.userId !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }

  if (Math.floor(Date.now() / 1000) >= payload.exp) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, payload };
}
