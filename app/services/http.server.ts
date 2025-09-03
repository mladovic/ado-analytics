import { getServerEnv } from "~/env.server";

/**
 * Build a stable hash for cache keys (FNV-1a 32-bit).
 * Internal helper shared by server utilities.
 * @internal
 */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

/**
 * Structured HTTP error for Azure DevOps calls.
 */
export class AdoHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly method: string;
  readonly attempt: number;
  readonly bodySnippet?: string;

  constructor(options: {
    status: number;
    url: string;
    method: string;
    attempt: number;
    bodySnippet?: string;
  }) {
    super(`${options.method} ${options.url} -> ${options.status} (attempt ${options.attempt})`);
    this.name = "AdoHttpError";
    this.status = options.status;
    this.url = options.url;
    this.method = options.method;
    this.attempt = options.attempt;
    this.bodySnippet = options.bodySnippet;
  }
}

/**
 * Specialized timeout error for ADO requests.
 */
export class AdoTimeoutError extends AdoHttpError {
  constructor(args: ConstructorParameters<typeof AdoHttpError>[0]) {
    super(args);
    this.name = "AdoTimeoutError";
  }
}

export type { AdoHttpError as AdoHttpErrorType };

// Minimal internal semaphore (p-limit style) to cap concurrency
type LimitFn = <T>(fn: () => Promise<T>) => Promise<T>;
function createLimit(concurrency: number): LimitFn {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (activeCount >= concurrency) return;
    const run = queue.shift();
    if (!run) return;
    activeCount++;
    run();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            activeCount--;
            next();
          });
      };
      queue.push(task);
      queueMicrotask(next);
    });
  };
}

const { APP_MAX_CONCURRENCY } = getServerEnv();
const concurrencyLimit = createLimit(APP_MAX_CONCURRENCY || 6);

// Internal constants
const DEFAULT_MAX_ATTEMPTS = 4; // 1 attempt + 3 retries
const BASE_DELAY_MS = 300;
const MAX_BODY_SNIPPET = 512;

/**
 * Merge headers and ensure Authorization + Accept are set for ADO JSON APIs.
 * @internal
 */
function buildAdoHeaders(initHeaders?: HeadersInit): Headers {
  const { ADO_PAT } = getServerEnv();
  const headers = new Headers(initHeaders ?? {});
  if (!headers.has("authorization")) {
    const token = Buffer.from(`:${ADO_PAT}`).toString("base64");
    headers.set("authorization", `Basic ${token}`);
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");
  return headers;
}

/**
 * Compute retry delay using Retry-After header or exponential backoff with jitter.
 * @internal
 */
function computeRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfterHeader);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const jitter = Math.floor(Math.random() * 101); // 0..100ms
  return BASE_DELAY_MS * Math.pow(2, attempt) + jitter;
}

/**
 * Minimal server-only fetch wrapper for Azure DevOps.
 * - Injects PAT-based Basic auth
 * - Ensures Accept: application/json
 * - Parses and returns JSON
 * - Throws AdoHttpError on non-2xx
 * - Retries on 429/5xx with exponential backoff and Retry-After
 * - Timeout/abort support (AdoTimeoutError)
 * - Concurrency capped via semaphore
 */
export async function adoFetchJson<T = unknown>(
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const { APP_REQUEST_TIMEOUT_MS } = getServerEnv();
  const method = (init.method ?? "GET").toUpperCase();
  const headers = buildAdoHeaders(init.headers);

  return concurrencyLimit(async () => {
    const controller = new AbortController();
    const userSignal = (init as any).signal as AbortSignal | undefined;
    const signal = userSignal ? AbortSignal.any([userSignal, controller.signal]) : controller.signal;

    let lastBodySnippet: string | undefined;

    for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, APP_REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, { ...init, method, headers, signal });

        if (res.ok) {
          clearTimeout(timeoutId);
          return (await res.json()) as T;
        }

        // Capture snippet for potential final error
        try {
          const text = await res.text();
          lastBodySnippet = text.length > MAX_BODY_SNIPPET ? text.slice(0, MAX_BODY_SNIPPET) : text;
        } catch {
          // ignore body read errors
        }

        const status = res.status;
        const shouldRetry = status === 429 || status >= 500;
        if (shouldRetry && attempt < DEFAULT_MAX_ATTEMPTS) {
          const delayMs = computeRetryDelayMs(attempt, res.headers.get("retry-after"));
          clearTimeout(timeoutId);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        clearTimeout(timeoutId);
        throw new AdoHttpError({ status, url, method, attempt, bodySnippet: lastBodySnippet });
      } catch (err) {
        clearTimeout(timeoutId);
        const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
        if (timedOut || aborted) {
          throw new AdoTimeoutError({ status: 408, url, method, attempt, bodySnippet: lastBodySnippet });
        }
        // Wrap other errors to normalize shape
        const snippet = err instanceof Error ? String(err.message ?? err) : String(err);
        throw new AdoHttpError({ status: 500, url, method, attempt, bodySnippet: snippet });
      }
    }

    // Safety net – should never reach here
    throw new AdoHttpError({ status: 500, url, method, attempt: DEFAULT_MAX_ATTEMPTS, bodySnippet: lastBodySnippet });
  });
}
