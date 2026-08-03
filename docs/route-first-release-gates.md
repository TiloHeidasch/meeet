# Route-first inactive release gates

This document certifies only the deterministic **inactive** route-first release
candidate. It does not activate route-first calculation, durable jobs, a routing
provider, POIs, or a production endpoint.

## Certified scope and non-claims

The certification scope is `route-first-inactive` with these immutable facts:

```json
{
  "releaseScope": "route-first-inactive",
  "activationEligible": false,
  "durable": false,
  "runtimePersistence": "in-memory-process",
  "activation": "blocked-until-durable-provider",
  "defaultStatus": "unavailable"
}
```

The report does not claim that route-first is activated, that jobs survive a
process restart, that enumeration is exhaustive in an activated deployment,
that MVG/MVV data is available, or that a deployment/provider has been
immutably attested. It also does not claim product approval, privacy approval,
capacity approval, or security approval.

## Automated command matrix

`npm run certify:route-first:inactive` runs these checks in this order and
records only status, duration, and recognized test-skip identities. Command
output is never written to the report.

The verifier first enforces the Node range declared in `package.json`:
`>=24.0.0 <25.0.0`. An unsupported runtime fails before any verification
subprocess, repository metadata command, or provider-facing code is started;
the report has an empty `checks` array and records `npm` as not checked.

| Order | Check | Command | Scope |
| ---: | --- | --- | --- |
| 1 | Full unit tests | `npm test` | All repository unit tests |
| 2 | TypeScript | `npm exec -- tsc --noEmit` | Strict typecheck |
| 3 | Lint | `npm run lint` | Repository lint |
| 4 | Playwright | `npm run test:e2e -- --reporter=json` | All Playwright specs, including future route-first specs |
| 5 | Routing config fixture | `python3 routing/scripts/validate-routing-config.py` | Static OTP/GraphHopper wiring only |
| 6 | Routing manifest fixture | `python3 routing/scripts/validate-routing-manifest.py --fixture routing/manifest/canonical-output.fixture.json` | Static canonical manifest contract only |
| 7 | Trace build | `npm run build:verify-trace` | Production build and NFT trace exclusion checks |
| 8 | Diff check | `git diff --check` | Whitespace validation |

Docker, live routing endpoints, external routing providers, POI services, feed
downloads, and deployment startup are intentionally not invoked.

Every verification subprocess receives an explicit allowlist environment. It
does not inherit `MEEET_*`, `ROUTING_*`, OTP integration settings, provider
URLs, credentials, tokens, or other secret-shaped environment variables.
Npm is also pointed at an empty user/global config for the run, so local npm
configuration cannot add registry credentials or provider settings. Provider
configuration is therefore absent even when the invoking shell has
development or deployment settings configured; the Playwright web server adds
only its explicit test-only fixture mode and blank endpoint overrides.

The Playwright suite still exercises the repository's existing browser-facing
checks. Its map style, sprite, tile-JSON, and vector-tile responses are
test-only offline fixtures; only the browser installation remains an external
test-environment prerequisite. Browser or other test-environment failures are
certification failures and are not evidence for activation.

## Report

The script writes `.artifacts/route-first-inactive-certification.json`, which
is ignored by Git. Use `--output <path>` to select another artifact path. The
report schema is `route-first-inactive-certification/v1` and contains:

- source revision and dirty-tree state;
- Node/npm versions and the declared Node engine;
- whether the explicit subprocess environment was started;
- ordered per-command status and duration;
- identified test-skip names;
- the exact inactive contract facts above;
- development-check status, certification pass/failure reasons; and
- allowed external activation blockers.

No environment values, URLs, tokens, cookies, request bodies, participant
identities or coordinates, raw command output, or raw manifests are emitted.
A dirty tree is always a release-candidate certification failure. The
explicitly named `--allow-dirty-development` option only permits development
checks to run and records the override; it never changes
`certification.passed:false` or `activationEligible:false`. The report keeps
`certification.developmentChecksPassed` separate from final certification so a
passing dirty-tree check cannot be mistaken for a certifiable release.

Playwright skip identities are read from its structured JSON reporter rather
than line-oriented output. The only currently allowed automated skip is the
exact unit-test identity:

`REQUIRED pinned OTP 2.6 gate introspects the live schema and executes paginated planConnection`

It must occur exactly once, and only from `full-unit-tests`; when present, it
is reported as an external activation blocker. Any other, renamed,
unidentified, duplicate, or unexpected skip fails certification. Missing or
malformed Playwright JSON reporter output also fails certification rather than
being treated as a zero-skip result.

## Activation blockers

An inactive report cannot satisfy these gates. Before any future activation,
separate evidence must be reviewed and attached for each item:

1. **Durable jobs:** shared durable job storage, restart/recovery semantics,
   bounded cleanup, isolation, and an operational retention policy.
2. **Exhaustive activated enumeration:** independently verified route
   enumeration, alternate/family certificates, graph/snapshot provenance, and
   evidence that activated work is complete rather than merely bounded.
3. **Immutable deployment/provider evidence:** pinned images, immutable
   manifests and attestations, verified runtime identity, read-only artifacts,
   and reproducible deployment configuration.
4. **MVG/MVV requirements:** verified Munich-only MVG/MVV data authority,
   feed freshness and licensing, realtime/schedule provenance, failure policy,
   and the exact provider activation contract.
5. **Privacy and security:** data minimization, session/job authorization,
   origin protection, logging review, threat-model review, and security signoff.
6. **Capacity:** production concurrency, queue, memory, timeout, rate-limit,
   cost, and load-test evidence with rollback thresholds.
7. **Manual product review:** UX/content review, Munich scope wording,
   accessibility, map-evidence review, and product-owner approval.

The external activation checklist must identify the evidence owner, artifact
digest or immutable revision, verification command, verification timestamp,
and reviewer/signoff for every blocker. Missing evidence keeps activation
blocked; a successful inactive certification never changes that state.
