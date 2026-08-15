import type { GeoJsonMultiPolygon } from "../types.ts";

/**
 * The scheduled-routing domain deliberately has its own models.  It is an
 * immutable, service-day based timetable model and is not a v2 meeting API
 * response type.
 */

export const SCHEDULED_ROUTING_CONTRACT_VERSION = "meeet-scheduled-routing/v1";
export type SelectedTolerancePercent = 5 | 10 | 15;
export const SCHEDULED_TOLERANCE_OPTIONS: readonly SelectedTolerancePercent[] = Object.freeze([5, 10, 15]);

export const SECONDS_PER_DAY = 86_400;
export const ROUTING_HORIZON_SECONDS = SECONDS_PER_DAY;
export const WALKING_SECONDS_ROUNDING_RULE =
  "ceil(distanceMetres / velocityMetresPerSecond), with zero distance taking zero seconds";

export type ScheduledDeadlinePhase =
  | "meeting-start"
  | "meeting-access"
  | "meeting-surface"
  | "meeting-result"
  | "routing-window"
  | "routing-scan"
  | "surface-cells";

/** Optional phase checkpoint; callers may inject the admission deadline check. */
export type ScheduledDeadlineCheck = (phase: ScheduledDeadlinePhase) => void;

export interface ScheduledCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export interface ScheduledRoute {
  readonly routeId: string;
  readonly shortName: string;
  readonly longName: string;
  readonly routeType: number;
}

export interface ScheduledStationArea {
  /** Parent-station identity, or the boarding stop identity for a stand-alone stop. */
  readonly id: string;
  readonly name: string;
  readonly coordinate: ScheduledCoordinate;
  readonly boardingStopIds: readonly string[];
  readonly parentStationId: string | null;
}

export interface ScheduledBoardingStop {
  readonly id: string;
  readonly name: string;
  readonly coordinate: ScheduledCoordinate;
  readonly stationAreaId: string;
}

/** Only regular boarding/alighting and explicit no-board/no-alight are routable. */
export type GtfsPickupDropOffType = 0 | 1;

export interface ScheduledTrip {
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly headsign: string;
}

/** A connection is relative to a GTFS service day, never to a civil Date. */
export interface ScheduledConnection {
  readonly id: string;
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly fromStopId: string;
  readonly toStopId: string;
  readonly fromStationAreaId: string;
  readonly toStationAreaId: string;
  readonly fromStopSequence: number;
  readonly toStopSequence: number;
  readonly departureTimeSeconds: number;
  readonly arrivalTimeSeconds: number;
  readonly pickupType: GtfsPickupDropOffType;
  readonly dropOffType: GtfsPickupDropOffType;
  readonly line: ScheduledRoute;
}

export interface ServiceCalendar {
  readonly serviceId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly weekdays: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
}

export interface ServiceException {
  readonly serviceId: string;
  readonly date: string;
  readonly exceptionType: 1 | 2;
}

export interface GtfsFileProvenance {
  readonly fileName: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Acquisition facts supplied by the feed compiler or deterministic fixtures. */
export interface GtfsAcquisitionRecord {
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly rawArchiveByteSize: number;
  readonly rawArchiveSha256: string;
  readonly feedVersion: string;
  readonly feedValidFrom: string;
  readonly feedValidUntil: string;
  readonly attribution: string;
  readonly officialAttribution: string;
  readonly officialLicense: {
    readonly name: string;
    readonly url: string;
  };
  readonly officialProvenance: {
    readonly source: "feed" | "meeet-policy";
    readonly policyId: "mvv-cc-by-4.0-fallback/v1" | null;
  };
}

export interface ScheduledSearchStartBounds {
  readonly earliestEpochSeconds: number;
  readonly latestEpochSeconds: number;
  readonly earliestAt: string;
  readonly latestAt: string;
  readonly maximumServiceDayTimeSeconds: number;
}

export interface ScheduledArtifactProvenance {
  readonly hashAlgorithm: "sha256";
  readonly contentHash: string;
  readonly feedId: string;
  readonly timeZone: string;
  readonly files: readonly GtfsFileProvenance[];
  readonly acquisition: GtfsAcquisitionRecord;
  /** Identity of the normalized compiled artifact, distinct from the raw ZIP hash. */
  readonly compiledArtifactId: string;
}

/** The value returned by the importer. All nested values are frozen. */
export interface ScheduledRoutingArtifact {
  readonly contractVersion: typeof SCHEDULED_ROUTING_CONTRACT_VERSION;
  readonly feedId: string;
  readonly timeZone: string;
  readonly maximumServiceDayTimeSeconds: number;
  readonly searchStartBounds: ScheduledSearchStartBounds;
  readonly serviceDateRange: {
    readonly firstDate: string;
    readonly lastDate: string;
  };
  readonly routes: readonly ScheduledRoute[];
  readonly trips: readonly ScheduledTrip[];
  readonly stationAreas: readonly ScheduledStationArea[];
  readonly boardingStops: readonly ScheduledBoardingStop[];
  readonly calendars: readonly ServiceCalendar[];
  readonly exceptions: readonly ServiceException[];
  readonly connections: readonly ScheduledConnection[];
  readonly provenance: ScheduledArtifactProvenance;
}

/** A bounded origin-to-station seed resolved by a later MVG adapter. */
export interface ScheduledAccessSeed {
  readonly stationAreaId: string;
  /** Exact boarding stop identity when the access provider resolved a stop. */
  readonly boardingStopId?: string;
  /** Seconds from searchStartAt until the participant can board this area. */
  readonly accessSeconds: number;
}

export interface ScheduledSurfaceCell {
  readonly id: string;
  /** Legacy rectangular center retained for grid identity; routing uses the disclosed point below. */
  readonly center: ScheduledCoordinate;
  /** Deterministic point strictly inside the clipped cell used for final walking. */
  readonly representativePoint: ScheduledCoordinate;
  readonly geometry?: GeoJsonMultiPolygon;
}

export interface StationArrivalField {
  readonly stationAreaId: string;
  readonly arrivalAt: string | null;
  readonly elapsedSeconds: number | null;
}

export interface CellArrivalField {
  readonly cellId: string;
  readonly arrivalAt: string | null;
  readonly elapsedSeconds: number | null;
}

export interface ScheduledParticipantSurface {
  readonly participantId: string;
  readonly stationArrivals: readonly StationArrivalField[];
  readonly cellArrivals: readonly CellArrivalField[];
}

export type ScheduledCellClassification = "red" | "blue" | "fair" | "unclassified";

export interface ScheduledClassifiedCell {
  readonly cellId: string;
  readonly classification: ScheduledCellClassification;
  readonly redArrivalSeconds: number | null;
  readonly blueArrivalSeconds: number | null;
  readonly fasterParticipant: "red" | "blue" | null;
  readonly withinSelectedTolerance: boolean;
}

export interface ScheduledSurfaceMetadata {
  readonly contractVersion: typeof SCHEDULED_ROUTING_CONTRACT_VERSION;
  readonly scheduleContentHash: string;
  readonly compiledArtifactId: string;
  readonly feedId: string;
  readonly timeZone: string;
  readonly searchStartAt: string;
  readonly routingHorizonSeconds: number;
  readonly selectedTolerancePercent: SelectedTolerancePercent;
  readonly walkingVelocityMetersPerSecond: number;
  readonly walkingSecondsRoundingRule: typeof WALKING_SECONDS_ROUNDING_RULE;
  readonly transferRadiusMeters: number;
  readonly accessSeedCounts: readonly [number, number];
  readonly stationAreaCount: number;
  readonly boardingStopCount: number;
  readonly connectionCount: number;
  readonly coverage: "scheduled-service-day-local-radius/v1";
  readonly representativePointBasis: "inside-clipped-cell/v1";
}

export interface ScheduledSurfaceResult {
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly participants: readonly [ScheduledParticipantSurface, ScheduledParticipantSurface];
  readonly cells: readonly ScheduledClassifiedCell[];
  readonly metadata: ScheduledSurfaceMetadata;
}

export interface ScheduledSurfaceInput {
  readonly schedule: ScheduledRoutingArtifact;
  /** Exactly two sets: set zero is red, set one is blue. */
  readonly accessSeedSets: readonly [readonly ScheduledAccessSeed[], readonly ScheduledAccessSeed[]];
  readonly searchStartAt: string;
  readonly selectedTolerancePercent: SelectedTolerancePercent;
  readonly cells: readonly ScheduledSurfaceCell[];
  readonly walkingVelocityMetersPerSecond: number;
  readonly transferRadiusMeters?: number;
  readonly participantIds?: readonly [string, string];
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export interface ScheduledRoutingOptions {
  readonly walkingVelocityMetersPerSecond?: number;
  readonly transferRadiusMeters?: number;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export interface ScheduledRoutingResult {
  readonly stationArrivals: readonly StationArrivalField[];
  readonly reachableStationAreaCount: number;
  readonly searchStartAt: string;
  readonly searchStartEpochSeconds: number;
  readonly horizonEndEpochSeconds: number;
}
