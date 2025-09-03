# Environment Loader with Zod — React Router v7 (Framework Mode)

**Audience:** Frontend engineers building an app with **React Router v7 (framework mode)** who want a **type‑safe environment loader** using **Zod**, for both server‑only secrets and safe client‑exposed variables.

This guide is **copy–paste friendly**: checklists + code you can drop in. It assumes **TypeScript**, **Vite** tooling (the default with RRV7 framework mode), and Node runtime for the server build.

---

## ✅ At a Glance (Checklist)

- [ ] Install deps: `zod`, `dotenv`, `dotenv-expand`
- [ ] Decide your env model: **server‑only**, **client‑exposed**, and **derived** values
- [ ] Create `.env` files and `.env.example`
- [ ] Implement **server env loader** (`app/env.server.ts`) with Zod validation (fail fast at boot)
- [ ] Implement **client env loader** (`app/env.client.ts`) validating `import.meta.env`
- [ ] Expose **safe env** to the client (via `VITE_` prefix or `define` injection)
- [ ] Add a tiny **isomorphic helper** (`app/env.ts`) that re‑exports the right loader per side
- [ ] Use the env in server entry routes/actions, loaders, and client components
- [ ] Add **tests** for validation and a **CI check** using `.env.example`

---

## 0) Why an Env Loader? (Short Version)

- **Fail fast**: detect missing/invalid config at boot, not at runtime.
- **Type safety**: consume **typed** `env` everywhere (autocomplete + IntelliSense).
- **Separation of concerns**: keep **secrets** on the server, expose only explicitly **whitelisted** vars to the browser.
- **Consistency**: same Zod patterns for server & client, with a single source of truth for variable names.

---

## 1) Install & Files

```bash
pnpm add zod
pnpm add -D dotenv dotenv-expand
```

**Create files:**

```
.env                 # local defaults (never commit secrets in a team repo)
.env.local           # developer overrides (gitignored)
.env.production      # used in prod/staging environments
.env.example         # committed, non-secret template of required variables
```

> **Tip:** Commit `.env.example` with dummy values to document required settings.

---

## 2) Pick Your Env Model

Group your variables by **audience**:

- **Server‑only (private):** PATs, DB strings, webhook secrets… _(never reachable by client code)._  
  Example: `ADO_PAT`, `SESSION_SECRET`, `LOG_LEVEL`.
- **Client‑exposed (public):** must start with `VITE_` so Vite injects them into the browser bundle.  
  Example: `VITE_APP_NAME`, `VITE_API_BASE_URL`.
- **Derived:** values computed from raw env (e.g., parsed URLs, numbers, booleans).

We’ll implement two Zod schemas: one for server, one for client.

---

## 3) Load `.env` Early (Server)

> We’ll load `.env` **before** importing code that reads `process.env` and expand variable references.

Create `app/load-dotenv.ts`:

```ts
// app/load-dotenv.ts
import * as dotenv from "dotenv";
import { expand } from "dotenv-expand";

// Load and expand once, as early as possible.
if (!process.env.__DOTENV_LOADED__) {
  const env = dotenv.config(); // reads .env* according to NODE_ENV by default
  expand(env);
  // marker to avoid reloading in tests/storybook
  process.env.__DOTENV_LOADED__ = "true";
}

declare global {
  // Allow our marker
  // eslint-disable-next-line no-var
  var __DOTENV_LOADED__: string | undefined;
}
```

Import this **at the very top** of your **server entry** (and any CLI/SSR entry), _before other imports_:

```ts
// server entry (e.g., server.ts / entry.server.ts / or your RR server bootstrap)
import "./app/load-dotenv";
// ...the rest of your server imports
```

---

## 4) Server Env Loader with Zod

Create `app/env.server.ts`:

```ts
// app/env.server.ts
import { z } from "zod";

/**
 * Define your required server-only env schema.
 * Never expose secrets to the client.
 */
export const ServerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5173),

  // Azure DevOps (server only)
  ADO_ORG: z.string().min(1, "ADO_ORG is required"),
  ADO_PROJECT: z.string().min(1, "ADO_PROJECT is required"),
  ADO_REPO_ID: z.string().min(1, "ADO_REPO_ID is required"),
  ADO_PAT: z.string().min(1, "ADO_PAT (server secret) is required"),

  // App tuning
  APP_MAX_CONCURRENCY: z.coerce.number().int().positive().max(32).default(6),
  APP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  APP_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Session/cookies
  SESSION_SECRET: z
    .string()
    .min(10, "SESSION_SECRET should be a long random string"),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  // Read from process.env; do not mutate it.
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `- ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    const hint = [
      "Environment validation failed.\n",
      issues,
      "\nCreate/update your .env or environment and re-run.",
      "See .env.example for the required variables.",
    ].join("\n");
    throw new Error(hint);
  }
  cached = parsed.data;
  return cached;
}
```

**Usage (server):**

```ts
import { getServerEnv } from "~/env.server";

const env = getServerEnv();
console.log("ADO project:", env.ADO_PROJECT);
```

> This **throws at boot** if variables are missing/invalid → safer deploys.

---

## 5) Client Env Loader with Zod

Vite injects **public** variables at build time via `import.meta.env`. Only variables prefixed with `VITE_` are exposed to the client bundle.

Create `app/env.client.ts`:

```ts
// app/env.client.ts
import { z } from "zod";

export const ClientEnvSchema = z.object({
  // Vite public vars (must start with VITE_)
  VITE_APP_NAME: z.string().default("ADO Analytics"),
  VITE_API_BASE_URL: z.string().url().default("/api"),
  VITE_FEATURE_FLAGS: z.string().optional(), // comma-separated "flagA,flagB"
});

export type ClientEnv = z.infer<typeof ClientEnvSchema>;

let cached: ClientEnv | null = null;

export function getClientEnv(): ClientEnv {
  if (cached) return cached;
  const raw = {
    VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    VITE_FEATURE_FLAGS: import.meta.env.VITE_FEATURE_FLAGS,
  };
  const parsed = ClientEnvSchema.safeParse(raw);
  if (!parsed.success) {
    if (import.meta.env.DEV) {
      console.error(parsed.error.format());
    }
    // In production, fail fast. In dev, you may choose to continue with defaults.
    throw new Error("Client environment validation failed.");
  }
  cached = parsed.data;
  return cached;
}
```

**Usage (client):**

```tsx
import { getClientEnv } from "~/env.client";

export function AppBrand() {
  const env = getClientEnv();
  return <span>{env.VITE_APP_NAME}</span>;
}
```

---

## 6) Isomorphic Helper (Optional but Handy)

A tiny shim that selects the right env at call site:

```ts
// app/env.ts
export { getClientEnv } from "./env.client";
export { getServerEnv } from "./env.server";
```

Then import from `"~/env"` in both server and client modules.

---

## 7) Exposing Additional Safe Server Values to the Client

Sometimes you need to pass **derived non‑secret** values to the browser that aren’t `VITE_` vars. Prefer **SSR data** (route loader) or **build‑time define**.

### 7.1 Build‑time define (Vite)

In `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // loads .env*
  return {
    define: {
      __APP_VERSION__: JSON.stringify(env.npm_package_version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  };
});
```

Use in client code:

```ts
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

console.log(__APP_VERSION__, __BUILD_TIME__);
```

> **Never** define secrets here—this is bundled client code.

### 7.2 Through SSR data

If you have route loaders (framework mode server side), send safe env via JSON and read on the client. _(Implementation depends on your RR server wiring.)_

---

## 8) .env.example (Template)

Create a template to document required vars:

```dotenv
# .env.example (do not put secrets you can’t share)
NODE_ENV=development
PORT=5173

# Azure DevOps
ADO_ORG=your-org
ADO_PROJECT=your-project
ADO_REPO_ID=your-repo-id
ADO_PAT=replace-with-a-PAT-for-local-dev

# App tuning
APP_MAX_CONCURRENCY=6
APP_REQUEST_TIMEOUT_MS=60000
APP_CACHE_TTL_MS=86400000

# Sessions
SESSION_SECRET=please-change-me

# Client (must start with VITE_ to be available in the browser)
VITE_APP_NAME=ADO Analytics
VITE_API_BASE_URL=/api
VITE_FEATURE_FLAGS=
```

---

## 9) Testing the Env Loader

### 9.1 Unit test server loader (Vitest)

```ts
// app/env.server.test.ts
import { beforeEach, expect, test } from "vitest";
import { getServerEnv } from "./env.server";

test("throws when required env is missing", () => {
  const backup = process.env;
  process.env = {};
  try {
    expect(() => getServerEnv()).toThrowError(/ADO_ORG is required/);
  } finally {
    process.env = backup;
  }
});
```

### 9.2 Unit test client loader

```ts
// app/env.client.test.ts
import { expect, test, vi } from "vitest";
import { getClientEnv } from "./env.client";

test("parses public env", () => {
  // Simulate Vite env
  const env = {
    VITE_APP_NAME: "Test",
    VITE_API_BASE_URL: "http://localhost:3000",
  };
  (globalThis as any).import = { meta: { env } };
  expect(() => getClientEnv()).not.toThrow();
});
```

> You can also set `import.meta.env` via Vitest config or by augmenting globals.

---

## 10) CI/CD & Boot Checks

- Add a **boot check**: import `getServerEnv()` at server start. If it throws, **fail deploy**.
- In CI, run a step that copies `.env.example` → `.env` (with dummy non‑secret values) and runs `tsc -p . && vite build` to verify env shape at build time.
- For prod, use the platform’s **secret manager** (never commit `.env.production` with secrets).

**Example CI snippet (GitHub Actions):**

```yaml
- name: Check env
  run: |
    cp .env.example .env
    pnpm build
```

---

## 11) Patterns & Gotchas

- **Do not import `env.client.ts` in server code**, or vice versa; keep boundaries clear.
- **Never export server secrets** from any module imported by the client bundle.
- **Use `z.coerce.number()`** for numeric env from strings.
- **Prefer defaults for toggles** (e.g., `FEATURE_X_ENABLED` → boolean coercion).
- **Avoid reading `process.env` in random modules**—centralize in the loader for consistency.
- **Feature flags:** ship as `VITE_FEATURE_FLAGS=flagA,flagB` and parse into a set on the client.

---

## 12) Quick Copy/Paste Recap

```bash
pnpm add zod
pnpm add -D dotenv dotenv-expand
```

- `app/load-dotenv.ts` (load `.env` early)
- `app/env.server.ts` (Zod schema + `getServerEnv()`)
- `app/env.client.ts` (Zod schema + `getClientEnv()`)
- `app/env.ts` (optional re‑exports)
- Add `.env`, `.env.local` (gitignored), `.env.example` (committed)
- Call `getServerEnv()` at server boot and before using env in server routes
- Use `VITE_` prefix for client‑visible variables; validate with `getClientEnv()`

---

## 13) Example Usage in Code

**Server (fetch Azure DevOps with PAT):**

```ts
import { getServerEnv } from "~/env.server";
const { ADO_PAT, ADO_ORG, ADO_PROJECT } = getServerEnv();
// use these to build your server-side ADO client
```

**Client (configure API base):**

```ts
import { getClientEnv } from "~/env.client";
const { VITE_API_BASE_URL } = getClientEnv();
fetch(`${VITE_API_BASE_URL}/metrics/people`);
```

---

You now have a robust, **type‑safe env system**: fail‑fast on the server, safe on the client, all powered by **Zod**.
