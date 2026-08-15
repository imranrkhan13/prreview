import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * The `state` param GitHub's OAuth flow round-trips through the redirect.
 * Signed and short-lived (5 minutes) so a callback request can be
 * confirmed to have originated from a login attempt this server actually
 * issued, rather than an attacker crafting their own callback URL
 * (CSRF / login-request-forgery on the OAuth flow).
 */

const STATE_TTL_SECONDS = 300;

export function createOAuthState(secret: string): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
  const payload = `${nonce}.${exp}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyOAuthState(state: string, secret: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, providedSignature] = parts;
  if (!nonce || !expStr || !providedSignature) return false;
  const payload = `${nonce}.${expStr}`;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");

  const providedBuf = Buffer.from(providedSignature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return false;
  }

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) >= exp) return false;

  return true;
}
