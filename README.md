# meeet

Munich-only meeting coordination for exactly two Participants. The canonical
server calculation compares planned public-transport arrivals from an
immutable MVV GTFS schedule and returns a Munich-clipped fairness surface.

## Local development

Requires Node `24.x`.

```bash
npm install
cp .env.example .env.local
npm run dev
```

The server accepts only the `meeet-meeting/v3` calculation contract. A request
contains two transit Participants, Munich origins, a whole-second
`searchStartAt`, and a selected 5%, 10%, or 15% tolerance. Responses disclose
access seeds, schedule provenance, and red/blue/fair/unclassified cells.

MVV GTFS is the only schedule/routing source. MVG is used for location search
and nearby access seeds only. The calculation does not use realtime, POIs,
walk navigation, or individual MVG journey/route calls.

## Schedule artifact

Compile the canonical MVV archive offline or explicitly as a deployment step:

```bash
npm run schedule:compile:mvv -- --input /absolute/path/feed.zip --output /absolute/path/mvv-scheduled-artifact.json
```

Set `MEEET_SCHEDULE_ARTIFACT_PATH` to the manifest. Production artifacts must
be compiled under Node 24, and deployment must provide the declared memory,
90-second API budget, and concurrency capacity for the full-feed window.

`MEEET_SCHEDULED_MIN_MEMORY_GIB` is a numeric configured deployment capacity
declaration with a conservative minimum of **4 GiB**. Fixture mode uses a
deterministic 4 GiB default. This is grounded in an observed 2.88 GiB Node 26
peak; it is not Node 24 capacity evidence. `MEEET_SCHEDULED_CONCURRENCY=1` is
the only supported value until a future explicitly versioned and certified
capacity policy changes it. `MEEET_SCHEDULED_DEADLINE_MS=90000` remains the API
budget until a Node 24 smoke proves release capacity.

The declaration does not replace the separate Node 24 two-participant smoke
condition. Legacy routing-gateway, geocoding, and POI endpoint/token/provenance
settings are rejected by active v3 configuration rather than ignored.

## Validation

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

The application boundary is Munich. Map rendering and browser fixture work are
owned by the visual/client migration; server code must preserve the v3
contract and its provenance checks.
