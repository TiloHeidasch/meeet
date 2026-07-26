# Phase 2 provider deployment contract

Runtime baseline: Node `>=22.0.0`, matching the pinned MapLibre 6 dependency
graph and the Next 16 application runtime.

The browser calls only `/api/meeting/calculate`. Provider endpoints and
credentials are read from server-only `MEEET_*` environment variables and are
never `NEXT_PUBLIC_*` values.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MEEET_PROVIDER_MODE` | `fixture`, `configured`, or `mvg-direct-transit`; defaults to `fixture` when no provider endpoint is present |
| `MEEET_PROVIDER_DEPLOYMENT` | `fixture`, `self-hosted`, `managed`, or `unknown` metadata; direct mode requires this to be omitted or `unknown` |
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

With no endpoint configured and no explicit direct mode, the deterministic local
providers remain active. If any endpoint is configured, missing provider
endpoints intentionally return `PROVIDER_NOT_CONFIGURED`; there is no
public-service fallback. Invalid configuration returns
`PROVIDER_CONFIGURATION_INVALID`. Configured network, timeout, response-size,
or shape failures return `PROVIDER_UNAVAILABLE`.
Configured URLs are fixed server-side allowlist entries; clients cannot submit
provider URLs. HTTPS is required by default and redirects are rejected.

In `mvg-direct-transit`, the mode-specific configuration checks reject any
deployment value other than omitted or `unknown`, and reject any non-empty
`MEEET_ROUTING_*`, `MEEET_GEOCODING_*`, or `MEEET_POI_*` variable. This includes
gateway URLs, tokens, and role-specific source metadata. Direct mode has no
configurable provider URL, requires no token, and does not require configured
feed/source provenance. The provider timeout and maximum-response settings
remain active; their direct-mode behavior is described below.

## Direct MVG transit mode

`MEEET_PROVIDER_MODE=mvg-direct-transit` selects a server-side routing provider
whose only network origin is the fixed unofficial MVG BGW PT v3 base endpoint:

```
https://www.mvg.de/api/bgw-pt/v3
```

The provider uses `/stations/nearby` and `/routes` below that base URL, sends no
token, rejects redirects, and has no configurable URL or routing fallback. This
is an unofficial integration with an unstable upstream and no SLA; use it for
moderate traffic only. It makes no claim to an official MVG API or to MVV data
or an official MVV API.

The direct routing contract is deliberately bounded:

- Transit mode only. Bike and car routing are not provided by this mode.
- A complete 2x2 Munich grid is selected, with 19 unique destinations. With
  four participants, this is 76 matrix entries; the grid is not truncated to
  fit a smaller partial result.
- Each participant origin and grid destination is snapped to the nearest
  returned station within 1,500 m. Access and egress use 75 m/min.
- Planned timestamps are used. Upstream realtime fields are ignored; this
  mode does not claim realtime predictions.
- The shared server-side upstream limiter allows four direct MVG requests in
  flight within one Node process/instance. This is not a deployment-wide
  distributed limit: multi-instance deployments can issue more concurrent
  requests and require external rate limiting if needed. One matrix
  calculation has a 12-second deadline, and an aborted browser/API request
  cancels queued and in-flight direct MVG work.
- `MEEET_PROVIDER_TIMEOUT_MS` still controls each direct HTTP call and remains
  bounded to 250–10,000 ms. `MEEET_PROVIDER_MAX_RESPONSE_BYTES` still applies,
  but each direct upstream response is capped at `min(setting, 128 KiB)`; the
  general setting remains bounded to 16 KiB–2 MiB. The example default of 512
  KiB therefore has an effective direct cap of 128 KiB.
- Direct requests have no automatic retries. Upstream timeout, network, HTTP,
  response-size, or shape failures do not fall back to fixture routing.

Direct mode composes the direct routing provider with fixture geocoding and
fixture POIs: submitted coordinates pass through the fixture geocoder without
an external geocoding call, and the POI result is drawn from static fixture
entries filtered to the resulting corridor.

Exact WGS84 participant origins and grid-destination coordinates are sent to
MVG's nearby-stations endpoint for station lookup. Subsequent route calls use
the selected station IDs and planned routing timestamps. Treat coordinates as
disclosed to MVG. The application does not establish the MVG operator's
logging or retention policy; that policy is uncertain, and application-side
request-log redaction and calculation-lifetime retention cannot guarantee what
the upstream retains.

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
