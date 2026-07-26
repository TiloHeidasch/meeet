# meeet

Munich-only meeting-place MVP. The browser calls same-origin route handlers;
provider URLs and credentials remain server-side.

## Local development

Requires Node `>=22.0.0` (the supported Next 16 / pinned MapLibre 6 runtime).

```bash
npm install
cp .env.example .env.local
npm run dev
```

With no `MEEET_*` provider endpoint configured, calculations use deterministic
local fixtures. This is not live MVG/MVV or realtime transit data.

## Map configuration

MapLibre requires a configured self-hosted or managed style URL:

```bash
NEXT_PUBLIC_MAP_STYLE_URL=https://maps.example.test/styles/meeet/style.json
NEXT_PUBLIC_MAP_ATTRIBUTION="Map data © deployment provider"
```

There is no public OSM tile, Nominatim, or other public-service fallback. The
style URL and attribution are the only map-service values exposed to the
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

Browser tests use a local fixture server with no map style or external provider
requests. Install the pinned Chromium binary once before running them:

```bash
npx playwright install chromium
npm run test:e2e
```
