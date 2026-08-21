/**
 * The scheduled-routing domain deliberately has its own models.  It is an
 * immutable, service-day based timetable model and is not a v2 meeting API
 * response type.
 */

export const SCHEDULED_ROUTING_CONTRACT_VERSION = "meeet-scheduled-routing/v1";
export type SelectedTolerancePercent = 5 | 10 | 15;
export const SCHEDULED_TOLERANCE_OPTIONS: readonly SelectedTolerancePercent[] = Object.freeze([5, 10, 15]);

/** Static intra-station change-time presets in seconds (ADR 0003). */
export const CHANGE_TIME_PRESETS = { quick: 180, medium: 300, long: 600 } as const;
export type ScheduledChangeTimePreset = keyof typeof CHANGE_TIME_PRESETS;

export const SECONDS_PER_DAY = 86_400;
export const ROUTING_HORIZON_SECONDS = SECONDS_PER_DAY;
export const WALKING_SECONDS_ROUNDING_RULE =
  "ceil(distanceMetres / velocityMetresPerSecond / 60) * 60, with zero distance taking zero seconds";

/**
 * Compile-time radius used to precompute static transfer-neighbor lists per
 * station area (issue #76). The scan uses the precomputed list for any runtime
 * `transferRadiusMeters` up to this value; larger radii fall back to the
 * geographic spatial index so results stay identical for every input.
 */
export const TRANSFER_NEIGHBOR_RADIUS_METERS = 1_000;

export type ScheduledDeadlinePhase =
  | "meeting-start"
  | "meeting-access"
  | "meeting-surface"
  | "meeting-result"
  | "routing-window"
  | "routing-scan"
  | "station-areas";

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

export type StationAreaMode = "sbahn" | "ubahn" | "tram" | "bus";

/** A precomputed transfer neighbor of a station area (issue #76). */
export interface ScheduledTransferNeighbor {
  /** The neighboring station area id within the precomputed transfer radius. */
  readonly stationAreaId: string;
  /** Precomputed haversine distance in meters between the two station-area centroids. */
  readonly distanceMeters: number;
}

export interface ScheduledStationArea {
  /** Parent-station identity, or the boarding stop identity for a stand-alone stop. */
  readonly id: string;
  readonly name: string;
  readonly coordinate: ScheduledCoordinate;
  readonly mode: StationAreaMode;
  /**
   * Static transfer-neighbor list precomputed at compile time within
   * `TRANSFER_NEIGHBOR_RADIUS_METERS`. Always includes the area itself with
   * `distanceMeters: 0`. The scan consumes this instead of a per-arrival
   * spatial query (issue #76).
   */
  readonly transferNeighbors: readonly ScheduledTransferNeighbor[];
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
  readonly fromStationAreaId: string;
  readonly toStationAreaId: string;
  /** Area-visit indices within the trip; consecutive connections continue the trip. */
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
  readonly calendars: readonly ServiceCalendar[];
  readonly exceptions: readonly ServiceException[];
  readonly connections: readonly ScheduledConnection[];
  readonly provenance: ScheduledArtifactProvenance;
}

/** A bounded origin-to-station seed resolved by a later MVG adapter. */
export interface ScheduledAccessSeed {
  readonly stationAreaId: string;
  /** Seconds from searchStartAt until the participant can board this area. */
  readonly accessSeconds: number;
}

export interface StationArrivalField {
  readonly stationAreaId: string;
  /** Raw arrival epoch seconds (UTC); the ISO string is derived only where consumed. */
  readonly arrivalEpochSeconds: number | null;
  readonly elapsedSeconds: number | null;
}

export interface ScheduledParticipantSurface {
  readonly participantId: string;
  readonly stationArrivals: readonly StationArrivalField[];
}

export type ScheduledStationAreaClassification = "red" | "blue" | "fair" | "unclassified";

export interface ScheduledStationAreaCandidate {
  readonly stationAreaId: string;
  readonly name: string;
  readonly coordinate: ScheduledCoordinate;
  readonly mode: StationAreaMode;
  readonly classification: ScheduledStationAreaClassification;
  readonly redArrivalSeconds: number | null;
  readonly blueArrivalSeconds: number | null;
  readonly fasterParticipant: "red" | "blue" | null;
  readonly withinSelectedTolerance: boolean;
}

export interface ScheduledStationAreaCatalogEntry {
  readonly stationAreaId: string;
  readonly name: string;
  readonly coordinate: ScheduledCoordinate;
  readonly mode: StationAreaMode;
}

export interface ScheduledStationAreaCatalog {
  readonly entries: readonly ScheduledStationAreaCatalogEntry[];
}

export interface ScheduledStationAreaMetadata {
  readonly count: number;
  readonly coverage: "official-munich-boundary-with-connected-artifact-station-areas/v1";
  readonly selection: "all-eligible-scheduled-station-areas/v1";
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
  readonly changeTimeSeconds: number;
  readonly walkingVelocityMetersPerSecond: number;
  readonly walkingSecondsRoundingRule: typeof WALKING_SECONDS_ROUNDING_RULE;
  readonly transferRadiusMeters: number;
  readonly accessSeedCounts: readonly [number, number];
  readonly stationAreaCount: number;
  readonly connectionCount: number;
  readonly coverage: "scheduled-service-day-local-radius/v1";
  readonly representativePointBasis: "station-area-coordinate/v1";
}

export interface ScheduledSurfaceResult {
  readonly status: "ok" | "no-result";
  readonly reason: "no-access-seeds" | "no-reachable-stations" | null;
  readonly participants: readonly [ScheduledParticipantSurface, ScheduledParticipantSurface];
  readonly stationAreas: readonly ScheduledStationAreaCandidate[];
  readonly metadata: ScheduledSurfaceMetadata;
}

export interface ScheduledSurfaceInput {
  readonly schedule: ScheduledRoutingArtifact;
  /** Exactly two sets: set zero is red, set one is blue. */
  readonly accessSeedSets: readonly [readonly ScheduledAccessSeed[], readonly ScheduledAccessSeed[]];
  readonly searchStartAt: string;
  readonly selectedTolerancePercent: SelectedTolerancePercent;
  /** Static intra-station change time in seconds; defaults to the medium preset. */
  readonly changeTimeSeconds?: number;
  readonly walkingVelocityMetersPerSecond: number;
  readonly transferRadiusMeters?: number;
  readonly participantIds?: readonly [string, string];
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export interface ScheduledRoutingOptions {
  readonly walkingVelocityMetersPerSecond?: number;
  readonly transferRadiusMeters?: number;
  /** Static intra-station change time in seconds; defaults to the medium preset. */
  readonly changeTimeSeconds?: number;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export interface ScheduledRoutingResult {
  readonly stationArrivals: readonly StationArrivalField[];
  readonly reachableStationAreaCount: number;
  readonly searchStartAt: string;
  readonly searchStartEpochSeconds: number;
  readonly horizonEndEpochSeconds: number;
  /**
   * Per-area predecessor edge produced by the certified scan. Used to rebuild a
   * participant's itinerary legs from the certified scheduled result without
   * re-running routing. Keyed by station-area id; only reached areas are present.
   * Stored as a plain object (never a Map) so it survives JSON cache serialization.
   */
  readonly predecessorByArea: Readonly<Record<string, ItineraryEdge>>;
}

/**
 * A single edge in the certified per-participant arrival graph. The graph is
 * reconstructed from the same scan that produced the certified marker arrivals,
 * so any itinerary derived from it is consistent with the cached marker.
 */
export type ItineraryEdge =
  | { readonly kind: "seed"; readonly seedAreaId: string; readonly accessSeconds: number }
  | { readonly kind: "connection"; readonly connection: ItineraryConnectionRef }
  | { readonly kind: "walk"; readonly fromAreaId: string; readonly arrivalEpochSeconds: number };

/** Compact, JSON-serializable reference to a transit connection for leg building. */
export interface ItineraryConnectionRef {
  readonly fromStationAreaId: string;
  readonly toStationAreaId: string;
  readonly departureEpochSeconds: number;
  readonly arrivalEpochSeconds: number;
  readonly tripId: string;
  readonly lineShortName: string;
  readonly routeType: number;
  readonly headsign: string;
}
