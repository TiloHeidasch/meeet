# ADR 0003 — Station-level scheduled routing with static change time

Status: accepted.

## Decision

The scheduled routing artifact is collapsed from boarding-stop level to
station-area level at compile time. Platform detail is statically removed:
connections become area-to-area, intra-area trip legs are dropped, and
consecutive same-area visits per trip are deduped keeping the earliest arrival.
The artifact no longer contains boarding stops.

Intra-station platform changes are modeled as a static, user-selected change
time instead of a computed platform walk. The presets are quick = 180 s,
medium = 300 s, long = 600 s — the highest value of each proposed range
(1–3 min, 3–5 min, 5–10 min). The scan applies the change time only when
boarding another trip at the same station area:

- same-area transfer: `arrival + changeTimeSeconds`
- different-area transfer within the 250 m radius:
  `arrival + walkingSeconds(areaA, areaB)`

No change time applies at the origin area (the participant walks in fresh) or
at the destination area (the meeting is reached).

The `meeet-meeting/v3` request gains the change-time selection; the response
station areas lose `redBoardingStopId`/`blueBoardingStopId`; the
station-area-details contract loses platform-level segments (boarding-stop
names, identity-resolution facts). Response metadata records the effective
change time as provenance.

This decision supersedes the boarding-stop identity guardrail: station-area
identity is preserved; boarding-stop identity is not.

## Rationale

The 30-second deadline regression (issue #20) showed that the full-feed
calculation is slow enough to fail a tight deadline outright. The dominant
routing phases — window materialization, the CSA scan, and transfer queries —
operate on 2,081,866 stop-level connections and 18,866 boarding stops.
Collapsing to 9,313 station areas removes intra-area legs, halves the transfer
candidate set, and eliminates platform-level access walking. Expected effect is
roughly 2x on the routing phases; the grid-cell surface (384 cells x 9,313
areas) is unaffected. The estimate is unmeasured and must be profiled before
and after the change.

A static change time is the standard transit-modeling pattern (GTFS
`transfer.txt` `min_transfer_time`) and fits the existing philosophy: the MVV
feed is the authority for scheduled times, while walking and transfer modeling
are already parameterized (velocity 1.4 m/s, radius 250 m). A fixed value per
preset preserves the pipeline's determinism — canonical scan, fingerprints,
certificates, and basis identity all require a single number, not a range.

## Consequences and trade-offs

- Results change deliberately: intra-area interchanges cost the preset change
  time instead of the actual platform walk; inter-area transfers become
  centroid-to-centroid, so a few currently valid platform-level transfers may
  fall outside the 250 m radius. With 5/10/15% tolerance, small time changes
  can flip red/blue/fair classifications.
- Contract changes: `meeet-meeting/v3` request and response shapes, the
  station-area-details contract, both validators, and the client contract.
  TDD applies to the contract retirement and the tamper seams.
- The routing-window cache key (artifact + search start + velocity + radius)
  must include the change time; any scan cache key must too.
- Access seeds resolve to station areas only; access walking is origin to area
  coordinate.
- The grid-cell surface, tolerance rules, 24-hour horizon, no-result
  semantics, and red/blue/fair/unclassified rules are unchanged.
- The performance win is bounded and unmeasured; the change time itself
  removes only a cheap per-transfer computation, while the collapse removes
  connections and transfer candidates. Profile before/after to attribute the
  win.