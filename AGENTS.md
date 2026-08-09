# meeet

## Product guardrails

- Keep the intentional `meeet` spelling. Build mobile-first; add desktop adaptations second.
- The MVP is Munich-only and must use MVG data. Do not imply broader geographic or transit-data coverage.
- The core flow supports exactly two participants placed on a map and calculates their public-transport travel times.
- Show a Route-Derived Fair Location Set generated from direct and anchor-station-constrained routes, with a configurable travel-time tolerance (default ±10%). POI discovery is out of scope for this MVP.
- Start with a selected tolerance of ±5%, ±10%, or ±15%; if no fair location exists, increase it by 5 percentage points until a location is found rather than returning an empty result.

## Current codebase

- The application entrypoints are `app/page.tsx`, `app/layout.tsx`, and `app/globals.css`.
- Use npm (`package-lock.json` is committed): `npm run dev`, `npm run lint`, `npm run build`, and `npm run start`. There is no test command.
- TypeScript is strict; `@/*` resolves from the repository root. Styling is Tailwind CSS v4.
- `app/layout.tsx` uses `next/font/google`; builds can require font network access or a populated cache.

## Next.js constraint

- This project uses a breaking-change-prone Next.js version. Before changing Next.js code, read the relevant guide in `node_modules/next/dist/docs/` and follow its deprecation notices.

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default canonical triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context layout. See `docs/agents/domain.md`.
