# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker, and defines the two fact dimensions every triaged ticket carries. Priority is **derived** from those facts — it is never stored as a label.

## State roles

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

## Effort — required on every triaged ticket

Every triaged ticket carries exactly one effort label, estimating implementation effort:

| Label      | Meaning                                    |
| ---------- | ------------------------------------------ |
| `effort: S`  | Small — a few hours, single focused change |
| `effort: M`  | Medium — 1–3 days of work                  |
| `effort: L`  | Large — up to a week of work               |
| `effort: XL` | Extra large — multiple weeks / multi-session work |

## Value — required on every triaged ticket

Every triaged ticket carries exactly one value label, expressing its **value** — user impact, strategic importance, dependency-criticality. Not urgency, not effort:

| Label          | Meaning                                       |
| -------------- | --------------------------------------------- |
| `value: high`   | High user value, strategic, or dependency-critical |
| `value: medium` | Valuable, but not urgent or dependency-critical    |
| `value: low`    | Useful polish or deferred improvement              |

## Priority — derived, never stored

Priority is a P1–P4 ranking **derived** from the effort × value matrix below. It is computed when sequencing tickets, not stored as a label — the labels carry facts, the matrix carries the ranking.

| value \ effort | `effort: S` | `effort: M` | `effort: L` | `effort: XL` |
| -------------- | ----------- | ----------- | ----------- | ------------ |
| `value: high`   | **P1**      | **P1**      | **P2**      | **P2**       |
| `value: medium` | **P1**      | **P2**      | **P3**      | **P3**       |
| `value: low`    | **P2**      | **P3**      | **P4**      | **P4**       |

- **P1** — pick up next (quick wins and high-value work)
- **P2** — strong candidates; do after P1
- **P3** — valuable but not urgent
- **P4** — parked; revisit when value or effort changes

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.