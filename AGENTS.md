# Repository Guidelines

## Project Structure & Module Organization

- app/: Application source code.
  - app/routes.ts: Route config (indexes, actions).
  - app/routes/: Route modules (e.g., home.tsx, action.set-theme.ts).
  - app/components/: Reusable UI (ui/, common/).
  - app/lib/: Utilities and server-side theme session.
- public/: Static assets (e.g., favicon).
- vite.config.ts: Vite + React Router + Tailwind setup.
- tsconfig.json: Path alias `~/*` → `app/*` and strict TS settings.

## Build, Test, and Development Commands

- npm run dev (or pnpm dev): Start dev server with HMR.
- npm run build (or pnpm build): Build client and server bundles.
- npm run start (or pnpm start): Serve built app from `build/server/index.js`.
- npm run typecheck: Generate route types and run TypeScript.

## Coding Style & Naming Conventions

- Language: TypeScript (strict). Components as function components.
- Import paths: Prefer `~/...` alias from `tsconfig.json`.
- Styling: Tailwind CSS v4 with `cn()` utility and CVA for variants.
- Files: PascalCase for React components (e.g., ModeToggle.tsx); kebab/dot patterns for routes/actions (e.g., action.set-theme.ts).
- Formatting/Lint: Follow Prettier-like 2-space indentation; keep files typed and narrow.

## Testing Guidelines

- Framework not set up yet. If adding tests, prefer Vitest + React Testing Library for units and Playwright for E2E.
- Place tests alongside source as `*.test.ts(x)`; keep routes/components isolated and mock loaders/actions as needed.
- Aim for meaningful coverage on loaders, actions, and critical UI logic.

## Commit & Pull Request Guidelines

- Commits: Imperative, concise subject (<= 72 chars) + details in body when needed (e.g., "Add theme toggle and wire session").
- PRs: Clear description, linked issues, screenshots for UI changes, and notes on route/loader/action impacts. Reference affected files under `app/`.
- Keep diffs focused; include small, targeted commits for reviewability.

## Security & Configuration Tips

- THEME_SESSION_SECRET: Set a strong value in production for theme cookies.
- Environment: Do not commit secrets. Use deployment-specific env injection.
- Docker: `Dockerfile` builds prod image; expose via `npm run start`.

## Architecture Overview

- React Router v7 full‑stack SSR with Vite. Routes declared in `app/routes.ts` and implemented in `app/routes/` with loaders/actions where applicable.
