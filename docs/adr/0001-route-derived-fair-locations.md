# Route-Guided Fair Location Search from MVG journeys

Status: accepted (revised)

meeet uses Route-Guided Fair Location Search rather than promising a complete Route-Derived Fair Location Set. The result is a bounded, sampled/discovery union of transit station locations sourced from direct and Anchor-Station-constrained MVG Route Patterns. It must disclose the sampled coverage and must not imply that skipped stations are unfair. This preserves the core benefit—comparable two-person planned travel times—while making the incompleteness explicit.

For the selected Arrival Time (initially one hour from search start), run every direct and Anchor-Station-constrained Route Pattern in both Participant-to-Participant directions. For each ordered pattern, consider transit stations only; walking endpoints and Participant Origins are not targets. Start at the pattern’s arithmetic middle station, compare the Participants’ planned Door-to-Door Travel Times independently, and move in the direction indicated by the time imbalance until reaching a local minimum of the absolute difference. That local minimum is an accepted trade-off for the pattern, not an absolute or global proof.

At the Organiser’s selected tolerance (±5%, ±10%, or ±15%), search all Route Pattern local minima. Escalate by five percentage points only when no discovered local minimum meets that tolerance. Return the union of discovered fair station locations, retaining source-pattern provenance and sampled coverage. Given unrounded planned journey times `a` and `b` and active tolerance `p`, pairwise fairness is `|a - b| <= p(a + b)`; planned times remain the fairness metric.

A Route Pattern with no transit station contributes no target and is an explicit no-result case; it does not fall back to an origin or walking endpoint. Provider and malformed-data failures remain operational errors.

The MVG journey response is authoritative for an individual Journey, including its access, egress, and transfers. Fairness uses planned timetable times; live disruption information may appear only in individual route details. A displayed Fair Location is an individual station marker with its source patterns and sampled coverage available for inspection; it is not connected to other markers in a way that implies an intervening area is also fair. POI discovery and selection remain outside the MVP.

## Consequences

- The source catalogue is deliberately finite: direct routes plus routes constrained through Hauptbahnhof (`de:09162:6`), Sendlinger Tor (`de:09162:50`), Universität (`de:09162:70`), Silberhornstraße (`de:09162:1170`), Rotkreuzplatz (`de:09162:190`), and Olympiazentrum (`de:09162:350`).
- Participant Origins and discovered station targets are within the City of Munich boundary. A Journey may leave that boundary when public transport requires it.
- Run direct and Anchor-Station-constrained Route Patterns in both directions and retain their provenance in the sampled coverage.
- A Route Pattern with no transit station contributes no target; there is no origin or walking-endpoint fallback.
- Merge repeated appearances of the same physical transit station while retaining all supporting Route Patterns.
- A Meeting Search starts at an Organiser-selected tolerance of ±5%, ±10% (default), or ±15%. Search all pattern local minima at that tolerance, then increase by five percentage points only if no discovered local minimum meets it.
- The search is bounded and sampled: it does not claim completeness, a continuous corridor, a global optimum, or that skipped stations are unfair.
- The selected Arrival Time must be from now through the end of the following calendar day. No discovered target is an explicit no-result case; provider and malformed-data failures remain operational errors rather than evidence that skipped stations are unfair.
