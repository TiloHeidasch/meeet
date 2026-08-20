import "server-only";

import type {
  ScheduledAccessSeedCandidate,
  ScheduledAccessSeedProvider,
  ScheduledAccessSeedRequest,
} from "../domain/providers.ts";
import type { ProviderDescriptor, ProviderProvenance } from "../domain/types.ts";
import { importGtfsSchedule, type GtfsFeedFiles } from "../domain/scheduled-routing/gtfs.ts";
import { walkingSeconds } from "../domain/scheduled-routing/router.ts";
import type { ScheduledRoutingArtifact } from "../domain/scheduled-routing/models.ts";

const FIXTURE_ACQUISITION = {
  sourceUrl: "https://example.test/fixture-mvv.zip",
  retrievedAt: "2026-08-01T00:00:00Z",
  rawArchiveByteSize: 1_024,
  rawArchiveSha256: "c".repeat(64),
  feedVersion: "fixture-scheduled-2026-08",
  feedValidFrom: "2026-08-01",
  feedValidUntil: "2026-08-31",
  attribution: "Local deterministic MVV timetable fixture",
  officialAttribution: "Local deterministic MVV timetable fixture",
  officialLicense: { name: "Fixture License", url: "https://example.test/license" },
  officialProvenance: { source: "feed", policyId: null } as const,
};

export const FIXTURE_SCHEDULED_GTFS_FILES: GtfsFeedFiles = {
  "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nfixture,Fixture MVV,https://example.test,Europe/Berlin",
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_version,feed_start_date,feed_end_date\nFixture MVV,https://example.test,de,fixture-scheduled-2026-08,20260801,20260831",
  "routes.txt": "route_id,route_short_name,route_type\nfixture-line,F,3",
  "stops.txt": [
    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
    "fixture-a,Fixture A,48.1374,11.5755,1,",
    "fixture-a-stop,Fixture A platform,48.1374,11.5755,0,fixture-a",
    "fixture-a-stop-2,Fixture A platform 2,48.1374,11.5755,0,fixture-a",
    "fixture-b,Fixture B,48.1400,11.5700,1,",
    "fixture-b-stop,Fixture B platform,48.1400,11.5700,0,fixture-b",
    "fixture-b-stop-2,Fixture B platform 2,48.1400,11.5700,0,fixture-b",
    "fixture-c,Fixture C,48.1450,11.5650,1,",
    "fixture-c-stop,Fixture C platform,48.1450,11.5650,0,fixture-c",
  ].join("\n"),
  "trips.txt": [
    "route_id,service_id,trip_id",
    "fixture-line,fixture-service,fixture-a-b",
    "fixture-line,fixture-service,fixture-b-c",
    "fixture-line,fixture-service,fixture-collapse",
    "fixture-line,fixture-service,fixture-return",
  ].join("\n"),
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
    "fixture-a-b,08:10:00,08:10:00,fixture-a-stop,1,0,0",
    "fixture-a-b,08:20:00,08:20:00,fixture-b-stop,2,0,0",
    "fixture-b-c,08:25:00,08:25:00,fixture-b-stop,1,0,0",
    "fixture-b-c,08:35:00,08:35:00,fixture-c-stop,2,0,0",
    "fixture-collapse,08:40:00,08:40:00,fixture-a-stop,1,1,0",
    "fixture-collapse,08:41:00,08:42:00,fixture-a-stop-2,2,0,0",
    "fixture-collapse,08:50:00,08:51:00,fixture-b-stop,3,0,1",
    "fixture-collapse,08:52:00,08:53:00,fixture-b-stop-2,4,0,0",
    "fixture-collapse,09:00:00,09:00:00,fixture-c-stop,5,0,0",
    "fixture-return,09:10:00,09:10:00,fixture-a-stop,1,0,0",
    "fixture-return,09:20:00,09:20:00,fixture-b-stop,2,0,0",
    "fixture-return,09:30:00,09:30:00,fixture-c-stop,3,0,0",
    "fixture-return,09:40:00,09:40:00,fixture-b-stop-2,4,0,0",
  ].join("\n"),
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nfixture-service,1,1,1,1,1,1,1,20260801,20260831",
};

export const FIXTURE_SCHEDULED_ARTIFACT: ScheduledRoutingArtifact = importGtfsSchedule(
  FIXTURE_SCHEDULED_GTFS_FILES,
  { feedId: "fixture-scheduled-feed", acquisition: FIXTURE_ACQUISITION, logProgress: false },
);

const fixtureProvenance: ProviderProvenance = {
  role: "access",
  provider: "fixture-scheduled-access",
  deployment: "fixture",
  dataKind: "demo-static",
  liveData: false,
  sourceUrl: "https://example.test/fixture-mvv-nearby",
  license: null,
  attribution: "Local deterministic MVG access-seed fixture; no upstream calls.",
  version: "fixture-scheduled-access-v1",
  retrievedAt: "fixture-static",
  notes: "Demo-only access seeds paired with a deterministic static timetable artifact.",
  feeds: null,
};

const fixtureDescriptor: ProviderDescriptor = {
  name: "fixture-scheduled-access",
  deployment: "fixture",
  dataKind: "demo-static",
  liveData: false,
  asOf: "fixture-scheduled-access-v1",
  notes: fixtureProvenance.notes,
  provenance: fixtureProvenance,
};

export const FIXTURE_SCHEDULED_ACCESS_PROVIDER: ScheduledAccessSeedProvider = {
  descriptor: fixtureDescriptor,
  async resolveAccessSeeds(request: ScheduledAccessSeedRequest): Promise<readonly ScheduledAccessSeedCandidate[]> {
    const candidates: ScheduledAccessSeedCandidate[] = ["fixture-a", "fixture-b"].map((stationAreaId) => {
      const area = request.schedule.stationAreas.find((candidate) => candidate.id === stationAreaId);
      if (area === undefined) throw new Error(`Fixture station area ${stationAreaId} is missing.`);
      const distanceMeters = Math.round(distanceMetersBetween(request.origin, area.coordinate));
      const accessSeconds = walkingSeconds(request.origin, area.coordinate, 1.4);
      return {
        seedId: `fixture-access:${stationAreaId}`,
        mvgStationId: stationAreaId,
        stationAreaId,
        coordinate: area.coordinate,
        accessSeconds,
        provenance: {
          source: "fixture-static",
          endpoint: "fixture-static",
          distanceMeters,
          walkingSeconds: accessSeconds,
          note: "No upstream service was contacted.",
        },
      };
    });
    return candidates;
  },
};

function distanceMetersBetween(
  first: { readonly latitude: number; readonly longitude: number },
  second: { readonly latitude: number; readonly longitude: number },
): number {
  const latitudeMeters = (second.latitude - first.latitude) * 111_000;
  const longitudeMeters = (second.longitude - first.longitude) * 111_000 * Math.cos((first.latitude * Math.PI) / 180);
  return Math.sqrt(latitudeMeters ** 2 + longitudeMeters ** 2);
}
