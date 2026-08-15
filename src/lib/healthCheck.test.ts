import { describe, it, expect, vi } from "vitest";
import { pollUntilHealthy } from "./healthCheck.js";

const noopSleep = async () => {};

describe("pollUntilHealthy", () => {
  it("succeeds on the first attempt when the URL responds immediately", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await pollUntilHealthy("https://example.up.railway.app", {
      timeoutMs: 5000,
      intervalMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noopSleep,
    });
    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("treats a non-2xx response as healthy (proves the process is up and listening)", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const result = await pollUntilHealthy("https://example.up.railway.app", {
      timeoutMs: 5000,
      intervalMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noopSleep,
    });
    expect(result.healthy).toBe(true);
  });

  it("retries on connection failure and succeeds once the app comes up", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call < 3) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    });
    const result = await pollUntilHealthy("https://example.up.railway.app", {
      timeoutMs: 5000,
      intervalMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noopSleep,
    });
    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("fails with a clear reason after the timeout elapses (never silently succeeds)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    // Use a fake sleep that actually advances a virtual clock so the
    // deadline math in pollUntilHealthy triggers without a real 5s wait.
    let virtualNow = 0;
    const realDateNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => virtualNow);
    const fastSleep = async (ms: number) => {
      virtualNow += ms;
    };

    const result = await pollUntilHealthy("https://example.up.railway.app", {
      timeoutMs: 300,
      intervalMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: fastSleep,
    });

    Date.now = realDateNow;

    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("respects a custom health check path", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      requestedUrl = url;
      return new Response("ok", { status: 200 });
    });
    await pollUntilHealthy("https://example.up.railway.app", {
      timeoutMs: 5000,
      intervalMs: 100,
      path: "/healthz",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noopSleep,
    });
    expect(requestedUrl).toBe("https://example.up.railway.app/healthz");
  });

  it("stops at maxAttempts even if the time budget hasn't run out (belt-and-braces cap)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await pollUntilHealthy("https://example.up.railway.app", {
      timeoutMs: 1_000_000, // huge time budget — maxAttempts should be the limiting factor
      intervalMs: 1,
      maxAttempts: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noopSleep,
    });
    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
