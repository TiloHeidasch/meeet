# Phase 2 provider deployment contract

Runtime baseline: Node `>=22.0.0`, matching the pinned MapLibre 6 dependency
graph and the Next 16 application runtime.

The browser calls only `/api/meeting/calculate`. Provider endpoints and
credentials are read from server-only `MEEET_*` environment variables and are
never `NEXT_PUBLIC_*` values.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MEEET_PROVIDER_MODE` | `fixture` or `configured`; defaults to `fixture` when no provider endpoint is present |
| `MEEET_PROVIDER_DEPLOYMENT` | `fixture`, `self-hosted`, `managed`, or `unknown` metadata |
| `MEEET_PROVIDER_TIMEOUT_MS` | HTTP timeout, bounded to 250–10,000 ms |
| `MEEET_PROVIDER_MAX_RESPONSE_BYTES` | Response limit, bounded to 16 KiB–2 MiB |
| `MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS` | Trusted local HTTP exception only; must remain false in production |
| `MEEET_ROUTING_GATEWAY_URL` / `_TOKEN` | Server-only routing gateway endpoint and optional bearer token |
| `MEEET_ROUTING_MVG_*` / `_MVV_*` | Required source URL, licence name/URL, attribution, version, and ISO retrieval date when routing is configured |
| `MEEET_GEOCODING_ENDPOINT` / `_TOKEN` | Server-only geocoding adapter endpoint and optional bearer token |
| `MEEET_POI_ENDPOINT` / `_TOKEN` | Server-only food/drink POI endpoint and optional bearer token |

Configured geocoding and POI endpoints additionally require their role-specific
`MEEET_GEOCODING_*` or `MEEET_POI_*` source name, HTTPS source URL, licence
name/URL, attribution, version, and ISO retrieval-date variables. Placeholder
or missing provenance fails configuration; it is never emitted as fixture
metadata.

With no endpoint configured, the deterministic local providers remain active.
If any endpoint is configured, missing provider endpoints intentionally return
`PROVIDER_NOT_CONFIGURED`; there is no public-service fallback. Invalid
configuration returns `PROVIDER_CONFIGURATION_INVALID`. Configured network,
timeout, response-size, or shape failures return `PROVIDER_UNAVAILABLE`.
Configured URLs are fixed server-side allowlist entries; clients cannot submit
provider URLs. HTTPS is required by default and redirects are rejected.

## Routing gateway

OTP does not provide a standard arbitrary travel-time matrix endpoint. The
configured routing endpoint is therefore a gateway contract, not a direct OTP
claim. The gateway receives one bounded request:

```json
{
  "contractVersion": "meeet-routing-gateway/v1",
  "departureAt": "2026-07-25T08:00:00.000Z",
  "timeZone": "Europe/Berlin",
  "participants": [
    {
      "participantId": "p1",
      "origin": { "latitude": 48.1374, "longitude": 11.5755 },
      "mode": "transit"
    }
  ],
  "destinations": [
    {
      "id": "cell-4-7-center",
      "coordinate": { "latitude": 48.14, "longitude": 11.57 },
      "sampleKind": "center"
    }
  ]
}
```

The gateway must return exactly one bounded matrix cell for every requested
participant/destination pair:

```json
{
  "contractVersion": "meeet-routing-gateway/v1",
  "departureAt": "2026-07-25T08:00:00.000Z",
  "travelTimes": [
    {
      "participantId": "p1",
      "destinationId": "cell-4-7-center",
      "mode": "transit",
      "status": "ok",
      "minutes": 18.4,
      "source": "deployment-specific-attribution"
    }
  ]
}
```

An unrouteable/no-itinerary pair is still a valid matrix cell with
`"status": "unreachable"` and `"minutes": null`. The calculation excludes
only samples/cells affected by such entries; transport, timeout, malformed,
or unavailable gateway failures use the 503 provider error path.

The gateway owns bounded OTP point-to-point scheduled calls, caching and
concurrency, licensed MVG plus licensed MVV GTFS coverage for transit, and
configured OSRM Table profiles for car/bike. OTP and OSRM are not contacted by
this application directly. The application does not claim realtime data;
configured routing is labelled scheduled only when the gateway deployment says
so. Actual gateway endpoints, credentials, graph builds, profiles, GTFS
licensing, and attribution remain deployment responsibilities.

The server forwards exact participant origins and grid destinations only to
the fixed gateway over its configured transport; it never exposes them to the
browser as provider requests. Gateway operators must encrypt transport, limit
access, redact origins from request/access logs, and set explicit retention
and deletion periods.

Before a configured gateway can activate, both MVG and licensed MVV feed
provenance must be recorded: source URL, licence name and URL, attribution,
version, and ISO retrieval date. The response exposes these records separately
from deployment kind and never labels configured data as fixture/static.

## Geocoding and POIs

The geocoding endpoint accepts:

```json
{
  "contractVersion": "meeet-geocoding/v1",
  "timeZone": "Europe/Berlin",
  "location": {
    "label": "Marienplatz",
    "latitude": 48.1374,
    "longitude": 11.5755
  }
}
```

and returns `{ "contractVersion": "meeet-geocoding/v1", "location": { "label", "latitude", "longitude" }, "source": { "name", "url", "license", "attribution", "version", "retrievedAt" } }`.
The POI endpoint accepts `contractVersion: "meeet-poi/v1"`,
`categories: ["food", "drink"]`, and the corridor GeoJSON, then returns
`{ "contractVersion": "meeet-poi/v1", "source": { "name", "url", "license", "attribution", "version", "retrievedAt" }, "pois": [...] }`. Both responses are bounded and shape-validated, and
resolved coordinates are checked against the official district collection.

Provider errors are generic to callers. The server does not log request bodies
or precise participant origins. Deployments must redact origin-bearing proxy
logs and use short retention; request coordinates are retained only for the
calculation lifetime.

## Boundary provenance

The application data asset is the WGS84 WFS layer
`gsm_wfs:vablock_stadtbezirk` from Munich GeoPortal. It is grouped into 25
district features and used only as application membership/clipping geometry,
not as a legal or cadastral boundary. Attribution is Landeshauptstadt München
/ GeodatenService München under DL-DE-BY-2.0. See
`data/official/munich-boundary-manifest.json` for source URL, retrieval date,
hashes, metadata hash, and licence. Refresh only server-side with
`npm run boundary:refresh`.

The UI must run `validateMeetingCalculationResponse` from the client-safe
`lib/client/meeting-response.ts` entrypoint before storing a result or passing
GeoJSON/POIs to MapLibre.
