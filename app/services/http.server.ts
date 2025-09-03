import { getServerEnv } from "~/env.server";

export class AdoHttpError extends Error {
  status: number;
  url: string;
  method: string;
  bodySnippet?: string;

  constructor(options: { status: number; url: string; method: string; bodySnippet?: string }) {
    super(`${options.method} ${options.url} -> ${options.status}`);
    this.name = "AdoHttpError";
    this.status = options.status;
    this.url = options.url;
    this.method = options.method;
    this.bodySnippet = options.bodySnippet;
  }
}

export type { AdoHttpError as AdoHttpErrorType };

/**
 * Minimal server-only fetch wrapper for Azure DevOps.
 * - Injects PAT-based Basic auth
 * - Ensures Accept: application/json
 * - Parses and returns JSON
 * - Throws AdoHttpError on non-2xx
 */
export async function adoFetchJson<T = unknown>(
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const { ADO_PAT, APP_REQUEST_TIMEOUT_MS } = getServerEnv();

  const headers = new Headers(init.headers ?? {});

  // Authorization: Basic base64(":" + PAT)
  if (!headers.has("authorization")) {
    const token = Buffer.from(`:${ADO_PAT}`).toString("base64");
    headers.set("authorization", `Basic ${token}`);
  }

  // Default Accept: application/json
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const method = (init.method ?? "GET").toUpperCase();

  // Timeout + abort support
  const controller = new AbortController();
  const userSignal = (init as any).signal as AbortSignal | undefined;
  // Combine caller-provided signal (if any) with our timeout controller
  const signal = userSignal
    ? AbortSignal.any([userSignal, controller.signal])
    : controller.signal;

  const maxAttempts = 4; // 1 attempt + 3 retries
  const baseDelayMs = 300;
  let lastBodySnippet: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, APP_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...init, method, headers, signal });

      if (res.ok) {
        clearTimeout(timeoutId);
        // Expect JSON
        return (await res.json()) as T;
      }

      // Capture snippet for potential final error
      try {
        const text = await res.text();
        lastBodySnippet = text.length > 512 ? text.slice(0, 512) : text;
      } catch {
        // ignore body read errors
      }

      const status = res.status;
      const shouldRetry = status === 429 || status >= 500;
      if (shouldRetry && attempt < maxAttempts) {
        // Respect Retry-After header if present
        const ra = res.headers.get("retry-after");
        let delayMs: number | undefined;
        if (ra) {
          const seconds = Number.parseInt(ra, 10);
          if (!Number.isNaN(seconds)) {
            delayMs = Math.max(0, seconds * 1000);
          } else {
            const dateMs = Date.parse(ra);
            if (!Number.isNaN(dateMs)) {
              delayMs = Math.max(0, dateMs - Date.now());
            }
          }
        }
        if (delayMs === undefined) {
          const jitter = Math.floor(Math.random() * 101); // 0..100ms
          delayMs = baseDelayMs * Math.pow(2, attempt) + jitter;
        }

        clearTimeout(timeoutId); // cleanup current attempt timer before waiting
        await new Promise((r) => setTimeout(r, delayMs));
        continue; // next attempt
      }

      // Not retrying – throw now with last snippet
      clearTimeout(timeoutId);
      throw new AdoHttpError({ status, url, method, bodySnippet: lastBodySnippet });
    } catch (err) {
      clearTimeout(timeoutId);
      // Translate our timeout into a typed error (do not retry timeouts)
      if (
        timedOut ||
        (err instanceof Error && err.name === "AbortError" && controller.signal.aborted)
      ) {
        const e = new AdoHttpError({ status: 408, url, method });
        e.name = "AdoTimeoutError";
        throw e;
      }
      // Other errors (network, etc.) – rethrow
      throw err;
    }
  }

  // Safety net – should never reach here
  throw new AdoHttpError({ status: 500, url, method, bodySnippet: lastBodySnippet });
}
