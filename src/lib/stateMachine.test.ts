import { describe, it, expect } from "vitest";
import { assertLegalTransition, canTransition, IllegalTransitionError } from "./stateMachine.js";

describe("deployment state machine", () => {
  it("allows the full happy path: queued -> provisioning -> deploying -> health_check -> live -> updating -> health_check -> live -> stopped", () => {
    expect(canTransition("QUEUED", "PROVISIONING")).toBe(true);
    expect(canTransition("PROVISIONING", "DEPLOYING")).toBe(true);
    expect(canTransition("DEPLOYING", "HEALTH_CHECK")).toBe(true);
    expect(canTransition("HEALTH_CHECK", "LIVE")).toBe(true);
    expect(canTransition("LIVE", "UPDATING")).toBe(true);
    expect(canTransition("UPDATING", "HEALTH_CHECK")).toBe(true);
    expect(canTransition("HEALTH_CHECK", "LIVE")).toBe(true);
    expect(canTransition("LIVE", "STOPPED")).toBe(true);
  });

  it("allows provisioning failures to be retried", () => {
    expect(canTransition("QUEUED", "PROVISIONING")).toBe(true);
    expect(canTransition("PROVISIONING", "FAILED")).toBe(true);
    expect(canTransition("FAILED", "PROVISIONING")).toBe(true);
  });

  it("allows TTL expiration from LIVE", () => {
    expect(canTransition("LIVE", "EXPIRED")).toBe(true);
  });

  it("rejects skipping straight from QUEUED to LIVE", () => {
    expect(canTransition("QUEUED", "LIVE")).toBe(false);
  });

  it("rejects skipping the health check on first provision", () => {
    expect(canTransition("DEPLOYING", "LIVE")).toBe(false);
    expect(canTransition("PROVISIONING", "LIVE")).toBe(false);
  });

  it("rejects skipping the health check on redeploy (UPDATING must go through HEALTH_CHECK)", () => {
    expect(canTransition("UPDATING", "LIVE")).toBe(false);
  });

  it("a timed-out/failed health check can only go to FAILED or STOPPED, never LIVE", () => {
    expect(canTransition("HEALTH_CHECK", "FAILED")).toBe(true);
    expect(canTransition("HEALTH_CHECK", "STOPPED")).toBe(true);
    expect(canTransition("HEALTH_CHECK", "QUEUED")).toBe(false);
    expect(canTransition("HEALTH_CHECK", "UPDATING")).toBe(false);
  });

  it("rejects any transition out of a terminal STOPPED state", () => {
    expect(canTransition("STOPPED", "LIVE")).toBe(false);
    expect(canTransition("STOPPED", "PROVISIONING")).toBe(false);
  });

  it("rejects any transition out of a terminal EXPIRED state", () => {
    expect(canTransition("EXPIRED", "LIVE")).toBe(false);
  });

  it("assertLegalTransition throws IllegalTransitionError on an illegal move", () => {
    expect(() => assertLegalTransition("QUEUED", "LIVE")).toThrow(IllegalTransitionError);
  });

  it("assertLegalTransition does not throw on a legal move", () => {
    expect(() => assertLegalTransition("QUEUED", "PROVISIONING")).not.toThrow();
  });
});
