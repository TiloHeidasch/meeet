# Issue #94 — batched canonical artifact hashing

## Measurement protocol

One downloaded 17,679,535-byte live MVV `20260803` archive was compiled by
`dev` (unbatched) and by `feature/94-batch-canonical-artifact-hashing` (batched),
using Node 24.19.0. Each side used three fresh-process successful runs of the
fixed profiling harness request: red `(48.1374, 11.5755)`, blue `(48.14,
11.57)`, tolerance 10%, medium change time, and
`2026-08-11T08:05:00+02:00`. Values below are medians in milliseconds; Δ is
after − before.

The acquisition timestamp was controlled by recomputing the after hash with
the feature code over the exact decoded artifact produced by `dev`. It exactly
matched the manifest `compiledArtifactId`, so both paths identify the same real
artifact:

- `contentHash`: `4e5e78f8a99fa6b4955cf4cff8a1cacba98d939afe9dc80f8383a811f91f5550`
- `compiledArtifactId`: `88e0e6b01a3f92900c37fd6b2992601b8600551d207e78bd843396ead691512d`
- payload: 808,821,104 bytes
- counts: 898 routes, 114,360 trips, 9,313 station areas, 2,075,789 connections

## Per-stage medians (ms)

| Stage | Before | After | Δ |
| --- | ---: | ---: | ---: |
| artifact-load | 18,278 | 11,772 | **−6,506** |
| access-seeds | 494 | 2,357 | +1,863 |
| station-area-catalog | 1,532 | 1,453 | −79 |
| routing-window | 711 | 613 | −98 |
| scan-red | 0 | 0 | 0 |
| scan-blue | 1,667 | 1,569 | −98 |
| participant-surfaces | 0 | 0 | 0 |
| station-area-evaluation | 1 | 1 | 0 |
| response-build | 0 | 0 | 0 |
| validation | 1,826 | 1,712 | −114 |
| serialization | 0 | 0 | 0 |
| **total** | **24,442** | **19,404** | **−5,038** |

The cold-load median is the evidence attributable to batching: canonical
identity recomputation occurs during artifact load, and it fell by 6,506 ms.
The total also includes unrelated stages; in particular, access-seed timing
includes live MVG variance. The other stage deltas should therefore not be
attributed to this change.

The deterministic fixture identity test separately asserts the known
pre-change content hash and compiled artifact ID. The UTF-8 regression fixture
leaves one byte before the 64 KiB batch boundary, then supplies a four-byte
emoji, forcing a flush before the emoji and checking the expected canonical
hash. Existing loader tests separately cover truncated and substituted payload
tampering, manifest compiled-ID mismatch, and raw-archive identity mismatch.

`git diff --check`: passed. Full-suite validation is owned by the parent
orchestrator.
