import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Helper: set minimal env before dynamically importing the module under test
function setEnv(overrides: Partial<Record<string, string>> = {}) {
  process.env.ADO_ORG = overrides.ADO_ORG ?? "org";
  process.env.ADO_PROJECT = overrides.ADO_PROJECT ?? "project";
  process.env.ADO_REPO_ID = overrides.ADO_REPO_ID ?? "repo";
  process.env.ADO_PAT = overrides.ADO_PAT ?? "pat";
  process.env.SESSION_SECRET = overrides.SESSION_SECRET ?? "0123456789abcdef";
  if (overrides.APP_REQUEST_TIMEOUT_MS)
    process.env.APP_REQUEST_TIMEOUT_MS = overrides.APP_REQUEST_TIMEOUT_MS;
  if (overrides.APP_MAX_CONCURRENCY)
    process.env.APP_MAX_CONCURRENCY = overrides.APP_MAX_CONCURRENCY;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.APP_REQUEST_TIMEOUT_MS;
  delete process.env.APP_MAX_CONCURRENCY;
});

describe("adoFetchJson retry/backoff and timeout", () => {
  it("retries on 429 using Retry-After seconds then succeeds", async () => {
    vi.useFakeTimers();
    setEnv();
    vi.resetModules();

    // First call -> 429 with Retry-After: 1 sec, then 200 OK
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "retry-after": "1" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { adoFetchJson } = await import("./http.server");

    const p = adoFetchJson("https://example.com/_apis/test");
    // Allow semaphore microtask to dispatch the first fetch
    await Promise.resolve();

    // After first response (429) we should be waiting 1000ms before retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(p).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries on 500 and throws AdoHttpError with attempt=4", async () => {
    vi.useFakeTimers();
    // Remove jitter for deterministic backoff timings
    vi.spyOn(Math, "random").mockReturnValue(0);
    setEnv();
    vi.resetModules();

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Internal", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { adoFetchJson, HttpError } = await import("./http.server");

    const url = "https://example.com/always-500";
    const p = adoFetchJson(url);
    const errP = p.catch((e) => e);
    await Promise.resolve();

    // attempt 1 -> 500, wait 600ms
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // attempt 2 -> 500, wait 1200ms
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // attempt 3 -> 500, wait 2400ms
    await vi.advanceTimersByTimeAsync(2400);

    const caught: unknown = await errP;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as InstanceType<typeof HttpError> & {
      status: number;
      url: string;
      method: string;
      attempt: number;
      bodySnippet?: string;
    };
    expect(err.status).toBe(500);
    expect(err.url).toBe(url);
    expect(err.method).toBe("GET");
    expect(err.attempt).toBe(4);
    // bodySnippet should be a string (error or response text), but content can vary
    expect(typeof err.bodySnippet === "string" || err.bodySnippet === undefined).toBe(true);
  });

  it("aborts on timeout and throws AdoTimeoutError (attempt=1)", async () => {
    vi.useFakeTimers();
    setEnv({ APP_REQUEST_TIMEOUT_MS: "5" });
    vi.resetModules();

    // Abort-aware fetch mock: rejects with AbortError when the signal aborts
    const fetchMock = vi.fn((_: any, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error("Aborted");
          (err as any).name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { adoFetchJson, HttpError } = await import("./http.server");

    const url = "https://example.com/slow";
    const p = adoFetchJson(url);
    const errP = p.catch((e) => e);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);

    const caught: any = await errP;
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught.name).toBe("AdoTimeoutError");
    expect(caught.status).toBe(408);
    expect(caught.url).toBe(url);
    expect(caught.method).toBe("GET");
    expect(caught.attempt).toBe(1);
  });
});
