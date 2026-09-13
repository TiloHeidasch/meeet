import "server-only";

import type {
  ScheduledMeetingParticipantInput,
  ScheduledMeetingStationAreaDto,
} from "../validation/meeting-v3.ts";
import type { GtfsAcquisitionRecord } from "./scheduled-routing/models.ts";
import type { ProviderDescriptor } from "./types.ts";

export const STATION_AREA_DETAILS_CONTRACT_VERSION = "meeet-station-area-details/v1" as const;

export type StationAreaDetailUnavailableReason =
  | "no-access-seeds"
  | "no-reachable-stations"
  | "station-area-unclassified"
  | "station-area-unavailable-for-participant";

export interface StationAreaDetailsBasisDto {
  readonly contractVersion: "meeet-meeting/v3";
  readonly searchStartAt: string;
  readonly selectedTolerancePercent: 5 | 10 | 15;
  readonly changeTimeSeconds: number;
  readonly routingHorizonSeconds: 86_400;
  readonly walkingVelocityMetersPerSecond: number;
  readonly walkingSecondsRoundingRule: string;
  readonly transferRadiusMeters: number;
  readonly deterministicSelectionPolicy: "earliest-arrival/canonical-scan-first/v1";
  readonly schedule: {
    readonly contractVersion: string;
    readonly feedId: string;
    readonly timeZone: string;
    readonly scheduleContentHash: string;
    readonly compiledArtifactId: string;
    readonly serviceDateRange: { readonly firstDate: string; readonly lastDate: string };
    readonly acquisition: GtfsAcquisitionRecord;
  };
  readonly accessProvider: ProviderDescriptor;
}

/**
 * One leg of a participant's certified itinerary to the selected station area.
 * Station-area granularity only (ADR 0003): legs reference station areas, never
 * boarding stops or platforms. `walk` legs carry no distance (no pedestrian
 * navigation); `transit` legs carry the MVV line identity and headsign.
 */
export type ItineraryLeg =
  | {
      readonly kind: "walk";
      readonly fromAreaId: string | null;
      readonly toAreaId: string;
      readonly fromAreaName: string | null;
      readonly toAreaName: string;
      readonly startEpochSeconds: number;
      readonly endEpochSeconds: number;
    }
  | {
      readonly kind: "transit";
      readonly fromAreaId: string;
      readonly toAreaId: string;
      readonly fromAreaName: string;
      readonly toAreaName: string;
      readonly line: string;
      readonly routeType: number;
      readonly headsign: string;
      readonly tripId: string;
      readonly startEpochSeconds: number;
      readonly endEpochSeconds: number;
    };

export interface StationAreaDetailParticipantDto {
  readonly id: string;
  readonly color: "red" | "blue";
  readonly origin: ScheduledMeetingParticipantInput["origin"];
  readonly status: "available" | "unavailable";
  readonly unavailableReason: StationAreaDetailUnavailableReason | null;
  readonly terminal: {
    readonly totalSeconds: number | null;
    readonly arrivalAt: string | null;
  };
  /** Certified leg-by-leg itinerary, or null when the participant is unavailable. */
  readonly itinerary: readonly ItineraryLeg[] | null;
}

export interface StationAreaDetailsResponseDto {
  readonly contractVersion: typeof STATION_AREA_DETAILS_CONTRACT_VERSION;
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly stationArea: ScheduledMeetingStationAreaDto;
  readonly participants: readonly [StationAreaDetailParticipantDto, StationAreaDetailParticipantDto];
  readonly basis: StationAreaDetailsBasisDto;
}