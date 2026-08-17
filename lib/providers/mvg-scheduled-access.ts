import "server-only";

import { haversineDistanceKm } from "../domain/geo.ts";
import type {
  ScheduledAccessSeedCandidate,
  ScheduledAccessSeedProvider,
  ScheduledAccessSeedRequest,
} from "../domain/providers.ts";
import type { ProviderDescriptor, ProviderProvenance } from "../domain/types.ts";
import { walkingSeconds } from "../domain/scheduled-routing/router.ts";
import {
  MVG_NEARBY_MAX_RESPONSE_BYTES,
  MVG_NEARBY_MAX_RADIUS_METERS,
  MVG_NEARBY_TIMEOUT_MS,
  fetchMvgNearbyStations,
  type MvgNearbyStation,
} from "./mvg-nearby.ts";
import { MVG_NEARBY_URL } from "./mvg-constants.ts";
import type { FetchImplementation } from "./http.ts";

export const MVG_SCHEDULED_ACCESS_MAX_SEEDS = 8;
export const MVG_SCHEDULED_ACCESS_WALKING_VELOCITY_METERS_PER_SECOND = 1.4;

export interface MvgScheduledAccessOptions {
  readonly walkingVelocityMetersPerSecond?: number;
  readonly maxSeeds?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImplementation?: FetchImplementation;
}

export class MvgScheduledAccessSeedProvider implements ScheduledAccessSeedProvider {
  readonly descriptor: ProviderDescriptor;
  private readonly options: Required<Omit<MvgScheduledAccessOptions, "fetchImplementation">> & Pick<MvgScheduledAccessOptions, "fetchImplementation">;

  constructor(options: MvgScheduledAccessOptions = {}) {
    this.options = {
      walkingVelocityMetersPerSecond: options.walkingVelocityMetersPerSecond ?? MVG_SCHEDULED_ACCESS_WALKING_VELOCITY_METERS_PER_SECOND,
      maxSeeds: options.maxSeeds ?? MVG_SCHEDULED_ACCESS_MAX_SEEDS,
      timeoutMs: options.timeoutMs ?? MVG_NEARBY_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? MVG_NEARBY_MAX_RESPONSE_BYTES,
      fetchImplementation: options.fetchImplementation,
    };
    if (!Number.isFinite(this.options.walkingVelocityMetersPerSecond) || this.options.walkingVelocityMetersPerSecond <= 0) throw new RangeError("Scheduled access walking velocity must be positive.");
    if (!Number.isSafeInteger(this.options.maxSeeds) || this.options.maxSeeds < 1 || this.options.maxSeeds > MVG_SCHEDULED_ACCESS_MAX_SEEDS) throw new RangeError("Scheduled access maxSeeds is outside its bounded range.");
    const provenance: ProviderProvenance = {
      role: "access",
      provider: "mvg-nearby-scheduled-access",
      deployment: "unknown",
      dataKind: "access",
      liveData: false,
      sourceUrl: MVG_NEARBY_URL,
      license: null,
      attribution: "MVG nearby station access only; timetable routing comes from the compiled MVV schedule.",
      version: "mvg-bgw-pt-v3-nearby",
      retrievedAt: new Date().toISOString(),
      notes: "This adapter calls only MVG nearby-station access and never MVG routes or journey endpoints.",
      feeds: null,
    };
    this.descriptor = {
      name: "mvg-nearby-scheduled-access",
      deployment: "unknown",
      dataKind: "access",
      liveData: false,
      asOf: "mvg-bgw-pt-v3-nearby",
      notes: provenance.notes,
      provenance,
    };
  }

  async resolveAccessSeeds(request: ScheduledAccessSeedRequest): Promise<readonly ScheduledAccessSeedCandidate[]> {
    if (request.signal?.aborted) throw new Error("MVG scheduled access request was aborted.");
    const stations = await fetchMvgNearbyStations(
      request.origin,
      this.options.fetchImplementation,
      request.signal,
      { timeoutMs: this.options.timeoutMs, maxResponseBytes: this.options.maxResponseBytes },
    );
    return createSeeds(request, stations, this.options.walkingVelocityMetersPerSecond, this.options.maxSeeds);
  }
}

function createSeeds(
  request: ScheduledAccessSeedRequest,
  stations: readonly MvgNearbyStation[],
  walkingVelocityMetersPerSecond: number,
  maxSeeds: number,
): readonly ScheduledAccessSeedCandidate[] {
  const stationAreas = new Set(request.schedule.stationAreas.map((area) => area.id));
  const candidates: Array<{ station: MvgNearbyStation; stationAreaId: string; distanceMeters: number; accessSeconds: number }> = [];
  const seenStationIds = new Set<string>();
  for (const station of stations) {
    if (seenStationIds.has(station.id)) continue;
    const stationAreaId = stationAreas.has(station.id) ? station.id : undefined;
    if (stationAreaId === undefined) continue;
    const distanceMeters = haversineDistanceKm(request.origin, station) * 1_000;
    if (distanceMeters > MVG_NEARBY_MAX_RADIUS_METERS) continue;
    seenStationIds.add(station.id);
    const accessSeconds = walkingSeconds(request.origin, station, walkingVelocityMetersPerSecond);
    candidates.push({ station, stationAreaId, distanceMeters, accessSeconds });
  }
  return candidates
    .sort((left, right) => left.distanceMeters - right.distanceMeters || left.station.id.localeCompare(right.station.id))
    .slice(0, maxSeeds)
    .map((candidate) => ({
      seedId: `mvg-access:${candidate.station.id}`,
      mvgStationId: candidate.station.id,
      stationAreaId: candidate.stationAreaId,
      coordinate: { latitude: candidate.station.latitude, longitude: candidate.station.longitude },
      accessSeconds: candidate.accessSeconds,
      provenance: {
        source: "mvg-nearby",
        endpoint: MVG_NEARBY_URL,
        distanceMeters: candidate.distanceMeters,
        walkingSeconds: candidate.accessSeconds,
        note: "Access duration is geographic walking time; no MVG journey was requested.",
      },
    }));
}
