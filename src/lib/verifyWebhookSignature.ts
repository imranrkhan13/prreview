import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a GitHub webhook payload against the `X-Hub-Signature-256` header.
 *
 * GitHub signs the *raw* request body with HMAC-SHA256 using the webhook
 * secret configured on the GitHub App / webhook. We must compare against the
 * raw bytes, not a re-serialized JSON object, or the signature will never
 * match for payloads with different key ordering or whitespace.
 *
 * Uses a timing-safe comparison to avoid leaking information via response
 * timing side channels.
 */
export function verifyWebhookSignature(params: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined | string[];
  secret: string;
}): boolean {
  const { rawBody, signatureHeader, secret } = params;

  if (!signatureHeader || Array.isArray(signatureHeader)) {
    return false;
  }

  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const bodyBuffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;

  const hmac = createHmac("sha256", secret);
  hmac.update(bodyBuffer);
  const computedDigest = expectedPrefix + hmac.digest("hex");

  const providedBuffer = Buffer.from(signatureHeader, "utf8");
  const computedBuffer = Buffer.from(computedDigest, "utf8");

  // timingSafeEqual requires equal-length buffers, or it throws.
  if (providedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, computedBuffer);
}
