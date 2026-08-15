import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./verifyWebhookSignature.js";

const secret = "test-secret";

function sign(body: string, withSecret = secret): string {
  return "sha256=" + createHmac("sha256", withSecret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = sign(body);
    expect(verifyWebhookSignature({ rawBody: body, signatureHeader: sig, secret })).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = sign(body, "wrong-secret");
    expect(verifyWebhookSignature({ rawBody: body, signatureHeader: sig, secret })).toBe(false);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const original = JSON.stringify({ amount: 10 });
    const tampered = JSON.stringify({ amount: 10000 });
    const sig = sign(original);
    expect(verifyWebhookSignature({ rawBody: tampered, signatureHeader: sig, secret })).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyWebhookSignature({ rawBody: body, signatureHeader: undefined, secret })).toBe(false);
  });

  it("rejects a malformed signature header without sha256= prefix", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(
      verifyWebhookSignature({ rawBody: body, signatureHeader: "not-a-real-sig", secret })
    ).toBe(false);
  });

  it("works against raw Buffer bodies identically to string bodies", () => {
    const body = JSON.stringify({ x: 1 });
    const sig = sign(body);
    expect(
      verifyWebhookSignature({ rawBody: Buffer.from(body, "utf8"), signatureHeader: sig, secret })
    ).toBe(true);
  });
});
