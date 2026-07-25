# meeet

## Product guardrails

- Keep the intentional `meeet` spelling. Build mobile-first; add desktop adaptations second.
- The MVP is Munich-only and must use MVG data. Do not imply broader geographic or transit-data coverage.
- The core flow supports 2+ participants placed on a map, each with a preferred travel mode (public transport, bike, or car).
- Show a map corridor for destinations participants can reach in equal travel time, with a configurable tolerance (default ±10%), then highlight POIs inside it.

## Current codebase

- This is still default Next.js App Router scaffolding: the application entrypoints are `app/page.tsx`, `app/layout.tsx`, and `app/globals.css`; no domain model, API routes, or tests exist yet.
- Use npm (`package-lock.json` is committed): `npm run dev`, `npm run lint`, `npm run build`, and `npm run start`. There is no test command.
- TypeScript is strict; `@/*` resolves from the repository root. Styling is Tailwind CSS v4.
- `app/layout.tsx` uses `next/font/google`; builds can require font network access or a populated cache.

## Next.js constraint

- This project uses a breaking-change-prone Next.js version. Before changing Next.js code, read the relevant guide in `node_modules/next/dist/docs/` and follow its deprecation notices.
