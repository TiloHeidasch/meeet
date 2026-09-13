# Issue #93 — strict key validation performance

Final controlled measurement after merging dev’s issue #94 batching work, using Node
24.19.0 and profiling harness v2. The harness launched exactly three fresh child
processes per variant. Both variants used the identical real artifact
`9f48cda6cf35b78e1aa6d16d330218134651067a1c2f1c45be80bd9a08b42b6e` (feed `20260803`,
9,313 station areas, 2,075,789 connections, payload 808,821,104 bytes) and the
standard fixed request: red `48.1374,11.5755`, blue `48.14,11.57`, tolerance 10%,
search start `2026-08-11T08:05:00+02:00`. No artifact was recompiled.

For the baseline only, `lib/domain/scheduled-routing/artifact.ts` was restored from
current `origin/dev` (post-#94, without #93), then the final implementation was
restored. The OS file cache was not dropped. The v2 request timer starts after
artifact load, so only `artifact-load` is attributable to this change.

## Median results (milliseconds)

| Measurement | Before | After | Delta |
| --- | ---: | ---: | ---: |
| artifact-load | 13,077 | 12,546 | −531 (−4.1%) |
| first request | 5,197 | 5,026 | −171 (−3.3%) |
| warm request | 2,038 | 1,963 | −75 (−3.7%) |

The first- and warm-request deltas include unrelated calculation and access variance
and are not attributable to issue #93. Ignored reports: `profiles/report-9f48cda6cf35-2026-08-21T14-18-19.890Z.json`
and `profiles/report-9f48cda6cf35-2026-08-21T14-19-25.963Z.json`.
