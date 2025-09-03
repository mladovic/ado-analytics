# Repository Guidelines

## Project Structure & Module Organization

- `app/`: Application source.
  - `routes.ts`: Route config (indexes, actions).
  - `routes/`: Route modules (e.g., `home.tsx`, `action.set-theme.ts`).
  - `components/`: Reusable UI (`ui/`, `common/`).
  - `lib/`: Utilities (e.g., `theme.server.ts`, `utils.ts`).
  - `services/`: Server‑side clients/cache/http helpers.
  - `models/`: Zod models for API types.
  - `env.server.ts`, `load-dotenv.ts`: Validated server environment.
- `test/`: Test setup (`setup/msw.ts`) and MSW handlers; unit tests are co‑located as `*.test.ts(x)` under `app/`.
- `public/`: Static assets.
- `react-router.config.ts`: Framework/SSR settings; `vite.config.ts`: Vite config; `tsconfig.json`: `~/` → `app/` alias.

## Build, Test, and Development Commands

- `npm run dev`: Start dev server with HMR.
- `npm run build`: Build client and server bundles.
- `npm run start`: Serve built SSR app from `build/server/index.js`.
- `npm run typecheck`: Generate route types and run TypeScript.
- `npm run test` | `test:watch`: Run Vitest (CI | watch).
- `npm run coverage`: Generate V8 coverage reports.
- `npm run e2e`: Run Playwright tests.

## Coding Style & Naming Conventions

- TypeScript (strict). Use `~/...` imports.
- Tailwind CSS v4; compose classes with `cn()`; CVA‑friendly UI.
- Components: PascalCase (e.g., `ModeToggle.tsx`). Routes/actions: kebab/dot (e.g., `action.set-theme.ts`).
- Formatting: Prettier‑like 2‑space indentation; keep modules focused and typed.

## Testing Guidelines

- Unit: Vitest (node env), MSW for HTTP mocks (`test/setup/msw.ts`).
- E2E: Playwright via `npm run e2e`.
- Location: Co‑locate as `*.test.ts(x)` near source; share handlers under `test/msw/`.
- Coverage: `npm run coverage` produces `text` and `lcov` reports.

## Commit & Pull Request Guidelines

- Commits: Imperative, concise subject (<= 72 chars) + body if needed.
- PRs: Clear description, linked issues, screenshots for UI changes, and notes on route/loader/action impacts; reference affected paths under `app/`.
- Keep diffs focused; prefer small, reviewable commits.

## Security & Configuration Tips

- Environment is validated (`app/env.server.ts`). Required: `ADO_ORG`, `ADO_PROJECT`, `ADO_REPO_ID`, `ADO_PAT`, `SESSION_SECRET`. Optional: `THEME_SESSION_SECRET`.
- Do not commit secrets; use `.env` locally and deployment‑specific env injection in production.
- Docker: Use `Dockerfile` to build; run with `--env-file ./.env` and `npm run start`.

## Architecture Overview

- React Router v7 full‑stack SSR with Vite. Routes are declared in `app/routes.ts` and implemented in `app/routes/*` with loaders/actions where applicable.
