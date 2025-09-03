// Tiny in-memory LRU cache with TTL, server-only.
// Usage:
//   const value = await getOrSet("key", 5_000, async () => fetchData())

type Entry<T> = {
  value?: T
  expiresAt: number
}

const store: Map<string, Entry<unknown>> = new Map()
const inFlight: Map<string, Promise<unknown>> = new Map()

let maxEntries = 500

function touch(key: string, entry: Entry<unknown>) {
  // Move to the most-recently-used position
  store.delete(key)
  store.set(key, entry)
}

function trim() {
  // Evict least-recently-used until within capacity
  while (store.size > maxEntries) {
    const firstKey = store.keys().next().value as string | undefined
    if (firstKey === undefined) break
    store.delete(firstKey)
  }
}

/**
 * Configure cache options.
 * - maxEntries: maximum number of keys before LRU eviction (default 500)
 */
export function configureCache(options: { maxEntries?: number } = {}) {
  if (typeof options.maxEntries === "number" && Number.isFinite(options.maxEntries)) {
    const next = Math.max(1, Math.floor(options.maxEntries))
    if (next !== maxEntries) {
      maxEntries = next
      trim()
    }
  }
}

/**
 * Get a cached value or compute and cache it.
 * - LRU policy on access
 * - TTL applied when the loader resolves
 */
export async function getOrSet<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  opts?: { bypass?: boolean },
): Promise<T> {
  // If bypass is requested, skip cache read and write-through entirely
  if (opts?.bypass) {
    return loader()
  }
  const now = Date.now()
  const existing = store.get(key) as Entry<T> | undefined

  if (existing) {
    // If we have a fresh value, return it
    if (existing.value !== undefined && existing.expiresAt > now) {
      touch(key, existing as Entry<unknown>)
      return existing.value
    }

    // Otherwise it's expired; drop and fall through to reload
    store.delete(key)
  }

  // If another request is already loading this key, return its promise
  const pending = inFlight.get(key) as Promise<T> | undefined
  if (pending) {
    return pending
  }

  // Start a new load and register it in the in-flight map to dedupe callers
  const p = loader()
  inFlight.set(key, p as Promise<unknown>)

  try {
    const value = await p
    inFlight.delete(key)

    const entry: Entry<T> = {
      value,
      expiresAt: Date.now() + Math.max(0, Math.floor(ttlMs)),
    }
    store.set(key, entry as Entry<unknown>)
    touch(key, entry as Entry<unknown>)
    trim()
    return value
  } catch (err) {
    // On failure, remove the entry if it still references this promise
    inFlight.delete(key)
    throw err
  }
}
