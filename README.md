# meeet

Munich-only meeting-place MVP. The browser calls same-origin route handlers;
provider URLs and credentials remain server-side.

## Local development

Requires Node `24.x` (the supported Next 16 / pinned MapLibre 6 runtime).

```bash
npm install
cp .env.example .env.local
npm run dev
```

With no provider mode or endpoint configured, calculations use the direct MVG
transit provider. Set `MEEET_PROVIDER_MODE=fixture` explicitly for deterministic
local fixtures; fixtures do not use MVG/MVV timetable data or realtime transit
data.

### Direct MVG transit mode

To enable the implemented direct mode, set the following server-only values:

```bash
MEEET_PROVIDER_MODE=mvg-direct-transit
MEEET_PROVIDER_DEPLOYMENT=unknown # or omit it
MEEET_PROVIDER_TIMEOUT_MS=4000
MEEET_PROVIDER_MAX_RESPONSE_BYTES=524288
```

This mode calls only the fixed, server-side unofficial endpoint
`https://www.mvg.de/api/bgw-pt/v3` (the nearby-stations and routes paths), with
no token. Any non-empty `MEEET_ROUTING_*`, `MEEET_GEOCODING_*`, or
`MEEET_POI_*` variable conflicts with this mode and is rejected; deployment
metadata must be omitted or `unknown`. The timeout and response-size settings
still apply. The direct provider shares a four-request upstream concurrency cap
within one Node process/instance; this is not a deployment-wide distributed
limit, so multi-instance deployments can issue more concurrent requests and
need external rate limiting if required. It enforces a 12-second calculation
deadline, and an aborted browser/API request cancels queued and in-flight direct
MVG work. Each upstream response is capped at 128 KiB (a larger configured
response limit does not raise that cap). It does not retry automatically.

Routing is transit-only and uses the complete 2x2 grid: 19 destinations and at
most 76 matrix entries for four participants. Origins and destinations are
snapped to a returned station within 1,500 m, with access and egress estimated
at 75 m/min. Realtime is used when the final route part supplies a valid
bounded arrival delay; planned timestamps are the fallback. Geocoding is
fixture coordinate pass-through and POIs are static fixtures; there is no
routing fallback. This mode does not provide bike or car routing and makes no
MVV or official-MVG-API claim.

Treat the upstream as moderate-use only: it is unofficial, undocumented,
potentially unstable, and has no SLA. Production or commercial use requires
permission. Exact participant and grid-destination coordinates
are sent to MVG for station lookup. The application cannot establish MVG
operator logging or retention guarantees, so treat upstream logging and
retention as uncertain; the existing server-side coordinate-lifetime and
request-log precautions do not change that.

## Map configuration

The map uses the OpenFreeMap Liberty style by default:

`https://tiles.openfreemap.org/styles/liberty`

Set `NEXT_PUBLIC_MAP_STYLE_URL` only when a self-hosted or managed style should
override that default:

```bash
NEXT_PUBLIC_MAP_STYLE_URL=https://maps.example.test/styles/meeet/style.json
NEXT_PUBLIC_MAP_ATTRIBUTION="Map data © deployment provider"
```

The style URL and attribution are the only map-service values exposed to the
browser. The existing Vercel Speed Insights client telemetry is also public by
design; do not put provider credentials in any `NEXT_PUBLIC_*` variable.

## Official boundary data

The runtime boundary is the cached WGS84 Munich GeoPortal
`gsm_wfs:vablock_stadtbezirk` district collection. It is application
membership/clipping geometry, not a legal or cadastral boundary. Attribution,
licence, retrieval metadata, and hashes are in
`data/official/munich-boundary-manifest.json`.

Refresh and validate it server-side only:

```bash
npm run boundary:refresh
```

## Provider deployment

See [`docs/provider-adapters.md`](docs/provider-adapters.md) for the complete
gateway, geocoding, POI, MVG/MVV provenance, OSRM, OTP, attribution, and
allowlisting contracts. A configured routing gateway must provide recorded
MVG and licensed MVV scheduled-feed source URLs, licences, attributions,
versions, and retrieval dates. The gateway owns bounded OTP point-to-point
calls and configured OSRM tables; this application does not pretend OTP has a
generic matrix endpoint.

Configure endpoints only as fixed server environment values. Do not forward
arbitrary client URLs. Exact participant coordinates are sensitive: retain
them only for the request lifetime, do not log request bodies/origins, and
apply deployment access-log redaction/retention controls.

## Validation

```bash
npm test
npm run test:e2e
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

Deterministic browser tests use a local fixture server and a stub of the
default style document. The isolated live OpenFreeMap regression checks the
real style dependency graph and therefore requires network access. Install
the pinned Chromium binary once before running them:

```bash
npx playwright install chromium
npm run test:e2e
```
