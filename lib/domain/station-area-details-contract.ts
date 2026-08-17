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
}

export interface StationAreaDetailsResponseDto {
  readonly contractVersion: typeof STATION_AREA_DETAILS_CONTRACT_VERSION;
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly stationArea: ScheduledMeetingStationAreaDto;
  readonly participants: readonly [StationAreaDetailParticipantDto, StationAreaDetailParticipantDto];
  readonly basis: StationAreaDetailsBasisDto;
}