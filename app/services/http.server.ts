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

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, APP_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...init, method, headers, signal });

    if (!res.ok) {
      let snippet: string | undefined;
      try {
        const text = await res.text();
        snippet = text.length > 2048 ? `${text.slice(0, 2048)}…` : text;
      } catch {
        // ignore body read errors
      }
      throw new AdoHttpError({ status: res.status, url, method, bodySnippet: snippet });
    }

    // Expect JSON
    // If response body is empty, this will throw; callers should ensure JSON endpoints.
    return (await res.json()) as T;
  } catch (err) {
    // Translate our timeout into a typed error
    if (
      timedOut ||
      (err instanceof Error && err.name === "AbortError" && controller.signal.aborted)
    ) {
      const e = new AdoHttpError({ status: 408, url, method });
      e.name = "AdoTimeoutError";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
