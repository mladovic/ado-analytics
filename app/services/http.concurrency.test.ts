import { describe, it, expect, vi, afterEach } from "vitest";

function setEnv() {
  process.env.ADO_ORG = "org";
  process.env.ADO_PROJECT = "project";
  process.env.ADO_REPO_ID = "repo";
  process.env.ADO_PAT = "pat";
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.APP_MAX_CONCURRENCY = "6";
  process.env.APP_REQUEST_TIMEOUT_MS = "60000";
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.APP_MAX_CONCURRENCY;
  delete process.env.APP_REQUEST_TIMEOUT_MS;
});

describe("adoFetchJson concurrency limit", () => {
  it("runs at most 6 concurrent requests", async () => {
    vi.useFakeTimers();
    setEnv();
    vi.resetModules();

    let inFlight = 0;
    let peak = 0;

    const fetchMock = vi.fn((_: any) => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          );
        }, 200);
      });
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { adoFetchJson } = await import("./http.server");

    const calls = Array.from({ length: 20 }, (_, i) =>
      adoFetchJson(`https://example.com/test-${i}`)
    );

    // Allow limiter to schedule the first batch
    await Promise.resolve();

    const all = Promise.all(calls);

    // Advance timers in 200ms waves; with limit=6 and 20 calls, ~4 waves suffice
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);

    await all;

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(peak).toBe(6);
    expect(inFlight).toBe(0);
  });
});

