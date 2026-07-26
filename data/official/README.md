# Official Munich application boundary asset

`munich-stadtbezirke.raw.geojson` is the cached WFS response from the official
Munich GeoPortal layer `gsm_wfs:vablock_stadtbezirk`, requested as WGS84
GeoJSON. The WFS currently returns 27 source features because two districts
are split into multiple geometry parts; `scripts/refresh-munich-boundary.ts`
groups those parts into exactly 25 district features in
`munich-districts.json`.

The runtime uses that district collection for point membership and grid-cell
clipping. It is application coverage geometry only, not a legal or cadastral
boundary. The source is the official Munich GeoPortal WFS layer
`gsm_wfs:vablock_stadtbezirk`, maintained by Landeshauptstadt München /
GeodatenService München and licensed under
[DL-DE-BY-2.0](https://www.govdata.de/dl-de/by-2-0).

The manifest records three different hashes:

- `rawContentHash` identifies the exact WFS response bytes cached in
  `munich-stadtbezirke.raw.geojson`. WFS serialization, feature ordering, or
  other response details can change between fetches, so this hash may change
  even when the district geometry does not.
- `normalizedContentHash` identifies the validated, grouped 25-district
  geometry in `munich-districts.json`. It can remain stable across such raw
  response changes and is the hash used to identify the runtime boundary
  representation.
- `metadataContentHash` identifies the WFS capabilities metadata response.

The refresh script hashes the bytes/text it is about to write, writes the raw
response, normalized collection, and manifest, then reads the raw and
normalized files back and compares their hashes before completing. A changed
raw hash alone is therefore a provenance update to inspect, not proof of a
boundary change. A changed `normalizedContentHash` means the runtime geometry
or normalized district data changed; review the district differences and
rerun the boundary and calculation checks before accepting it.

Refresh reproducibly with:

```bash
npm run boundary:refresh
```

The script fetches the WFS feature response and its current WFS capabilities
metadata, validates WGS84 coordinate ranges and district geometry, requires
district IDs `01`–`25`, applies Munich-specific envelope and topology checks,
then writes all three assets. No automatic refresh schedule is implied; run it
when an updated source snapshot is intentionally being reviewed.
