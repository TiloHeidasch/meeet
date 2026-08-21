# Issue #93 — strict key validation performance

Measured with Node 24.19.0 using three fresh Node processes per variant. Every run
used the identical real artifact `9f48cda6cf35b78e1aa6d16d330218134651067a1c2f1c45be80bd9a08b42b6e`
(feed `20260803`, 9,313 station areas, 2,075,789 connections, payload
808,821,104 bytes) and the standard fixed harness request (red `48.1374,11.5755`,
blue `48.14,11.57`, tolerance 10%, search start
`2026-08-11T08:05:00+02:00`). No artifact was recompiled between variants.

For the before measurement only, the old sorted `hasExactKeys` implementation was
temporarily reinstated and then restored. A fresh process makes the application
cache cold; the OS file cache was not intentionally dropped.

## Results (milliseconds)

| Measurement | Before runs | Before median | After runs | After median | Delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| artifact-load | 18,353 / 18,044 / 18,006 | 18,044 | 16,808 / 16,923 / 17,030 | 16,923 | −1,121 (−6.2%) |
| Total | 24,326 / 23,829 / 23,768 | 23,829 | 22,749 / 22,585 / 22,557 | 22,585 | −1,244 (−5.2%) |

The total includes work outside strict key validation, so its reduction should not be
attributed entirely to this change.
