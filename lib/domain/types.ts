export const TRAVEL_MODES = ["transit", "bike", "car"] as const;

export type TravelMode = (typeof TRAVEL_MODES)[number];

export const TOLERANCE_PERCENT_OPTIONS = [5, 10, 15] as const;

export type TolerancePercent = (typeof TOLERANCE_PERCENT_OPTIONS)[number];

export const DEFAULT_TOLERANCE_PERCENT: TolerancePercent = 10;
export const MEETING_TIME_ZONE = "Europe/Berlin" as const;

export type MeetingTimeZone = typeof MEETING_TIME_ZONE;

export interface LocationCoordinate {
  latitude: number;
  longitude: number;
}

export type Coordinate = LocationCoordinate;

export interface MeetingLocation extends LocationCoordinate {
  label: string;
}

export interface MeetingParticipant {
  id: string;
  location: MeetingLocation;
  mode: TravelMode;
}

export type GeoJsonPosition = [number, number];

/** A stop-sequence geometry returned for a detailed venue route. */
export interface GeoJsonLineString {
  type: "LineString";
  coordinates: GeoJsonPosition[];
}

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: GeoJsonPosition[][];
}

export interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: GeoJsonPosition[][][];
}

export type GeoJsonGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

export interface RoutingParticipant {
  participantId: string;
  origin: LocationCoordinate;
  mode: TravelMode;
}

export type GridSampleKind = "center" | "vertex";

export interface RoutingMatrixDestination {
  id: string;
  coordinate: LocationCoordinate;
  sampleKind: GridSampleKind;
}

export interface RoutingMatrixRequest {
  participants: readonly RoutingParticipant[];
  destinations: readonly RoutingMatrixDestination[];
  departureAt: string;
  signal?: AbortSignal;
}

export interface RoutingMatrixCell {
  participantId: string;
  destinationId: string;
  mode: TravelMode;
  status: "ok" | "unreachable";
  minutes: number | null;
  source: string;
}

export interface RoutingMatrixTimingMetadata {
  dataKind: "scheduled" | "live";
  liveData: boolean;
}

export interface RoutingMatrixResponse {
  contractVersion: "meeet-routing-gateway/v1";
  departureAt: string;
  travelTimes: readonly RoutingMatrixCell[];
  /** Timing provenance for the itineraries selected for this request. */
  timing?: RoutingMatrixTimingMetadata;
}

export interface RoutingProviderCapabilities {
  supportedModes: readonly TravelMode[];
  maxParticipants: number;
  maxDestinations: number;
  maxMatrixEntries: number;
}

export interface TransitLineReference {
  /** Stable provider line identity, falling back to its normalized type. */
  identity: string;
  type: string;
}

export interface GridCell {
  id: string;
  row: number;
  column: number;
  center: LocationCoordinate;
  representativePoint: LocationCoordinate;
  vertices: readonly LocationCoordinate[];
  geometry: GeoJsonMultiPolygon;
  sampleDestinationIds: readonly string[];
}

export interface BoundedMunichGrid {
  columns: number;
  rows: number;
  cells: readonly GridCell[];
  destinations: readonly RoutingMatrixDestination[];
}

export type PoiCategory = "food" | "drink";

export interface MeetingPointOfInterest {
  id: string;
  name: string;
  category: PoiCategory;
  coordinates: GeoJsonPosition;
  address?: string;
  source: string;
}

export type ProviderDeploymentKind =
  | "fixture"
  | "self-hosted"
  | "managed"
  | "unknown";

export type ProviderDataKind = "demo-static" | "scheduled" | "live" | "unknown";

export interface ProviderDescriptor {
  name: string;
  deployment: ProviderDeploymentKind;
  dataKind: ProviderDataKind;
  liveData: boolean;
  asOf: string;
  notes: string;
  provenance: ProviderProvenance;
}

export interface SourceLicense {
  name: string;
  url: string;
}

export interface FeedProvenance {
  name: "MVG" | "MVV";
  sourceUrl: string;
  license: SourceLicense;
  attribution: string;
  version: string;
  retrievedAt: string;
}

/** The application consumes the immutable handoff emitted by the deployment generator. */
export const ROUTING_SNAPSHOT_CONTRACT_VERSION = "meeet-routing-manifest/v1" as const;

export type RoutingSnapshotContractVersion = typeof ROUTING_SNAPSHOT_CONTRACT_VERSION;
export type RoutingSnapshotEngine = "otp-graphhopper";
export type RoutingSnapshotRealtimeState = "scheduled" | "live" | "unknown";
export type RoutingSnapshotFeedRole = "authoritative-schedule" | "metadata-enrichment";

export interface RoutingArtifactIdentity {
  id: string;
  contentHash: string;
}

export interface RoutingEngineImageIdentity extends RoutingArtifactIdentity {
  image: string;
  digest: string;
  version: string;
}

export interface RoutingSnapshotFeed extends FeedProvenance {
  feedId: string;
  contentHash: string;
  asOf: string;
  role: RoutingSnapshotFeedRole;
}

export interface RoutingSnapshotOsmSource {
  id: string;
  contentHash: string;
  sourceUrl: string;
  license: SourceLicense;
  attribution: string;
  version: string;
  retrievedAt: string;
  asOf: string;
}

export interface RoutingSnapshotConfigSource {
  id: string;
  contentHash: string;
  asOf: string;
}

export interface RoutingSnapshotAccessEnvelope {
  artifact: RoutingArtifactIdentity;
  extentKm: 15;
  bounds: {
    minLatitude: number;
    maxLatitude: number;
    minLongitude: number;
    maxLongitude: number;
  };
}

export type RoutingAccessEnvelopeGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

export interface RoutingSnapshotApplicationState {
  mvv: {
    role: "authoritative-schedule";
    applied: true;
  };
  mvg: {
    role: "metadata-enrichment";
    applied: false;
  };
  realtime: {
    state: "frozen";
    dataState: RoutingSnapshotRealtimeState;
    applied: false;
  };
}

/** Immutable routing-data identity used by route-first adapters. */
export interface RoutingSnapshot {
  contractVersion: RoutingSnapshotContractVersion;
  engine: RoutingSnapshotEngine;
  manifestId: string;
  generatedAt: string;
  engines: {
    otp: RoutingEngineImageIdentity;
    graphhopper: RoutingEngineImageIdentity;
  };
  profiles: {
    otp: string;
    bike: string;
    car: string;
  };
  feeds: readonly RoutingSnapshotFeed[];
  osm: RoutingSnapshotOsmSource;
  config: RoutingSnapshotConfigSource;
  artifacts: {
    graph: RoutingArtifactIdentity;
    input: RoutingArtifactIdentity;
  };
  officialBoundary: RoutingArtifactIdentity;
  accessEnvelope: RoutingSnapshotAccessEnvelope;
  realtime: {
    state: "frozen";
    dataState: RoutingSnapshotRealtimeState;
    artifact: RoutingArtifactIdentity;
    timestamp: string | null;
  };
}

export type RoutingManifest = RoutingSnapshot;

/** A route-first result scoped to the engine artifact that produced it. */
export interface RoutingEngineSnapshot {
  manifest: RoutingSnapshot;
  engine: "otp" | "graphhopper";
  graphArtifact: RoutingArtifactIdentity;
  inputArtifact: RoutingArtifactIdentity;
}

export interface RoutingFoundationCapability {
  state: "configured-foundation";
  calculationAvailable: false;
  reason: CalculationUnavailableReason;
  supportedModes: readonly TravelMode[];
  snapshot: RoutingSnapshot;
  applicationState: RoutingSnapshotApplicationState;
}

export type CalculationUnavailableReason = "calculation-not-migrated";

export const ROUTE_FIRST_CONTRACT_VERSION = "meeet-route-first/v1" as const;
export type PointToPointStepMode = TravelMode | "walk" | "wait";

export interface PointToPointRoutingRequest {
  origin: LocationCoordinate;
  destination: LocationCoordinate;
  departureAt: string;
  mode: TravelMode;
  signal?: AbortSignal;
}

export interface PointToPointRouteStep {
  kind: "leg" | "wait";
  mode: PointToPointStepMode;
  instruction: string;
  from: LocationCoordinate;
  to: LocationCoordinate;
  fromStopId: string | null;
  toStopId: string | null;
  line: TransitLineReference | null;
  departureAt: string;
  arrivalAt: string;
  durationMilliseconds: number;
  durationSeconds: number | null;
  geometry: GeoJsonLineString | null;
}

export interface PointToPointRoute {
  mode: TravelMode;
  durationMilliseconds: number;
  durationSeconds: number | null;
  departureAt: string;
  arrivalAt: string;
  geometry: GeoJsonLineString | null;
  steps: readonly PointToPointRouteStep[];
  source: string;
}

export interface PointToPointRoutingResult {
  contractVersion: typeof ROUTE_FIRST_CONTRACT_VERSION;
  routes: readonly PointToPointRoute[];
  exhaustive: false;
  snapshot: RoutingEngineSnapshot;
}

export interface SelfHostedRoutingAdapterDescriptor {
  engine: "otp" | "graphhopper";
  endpoint: string;
  profile: string;
  capabilities: RoutingProviderCapabilities;
  snapshot: RoutingEngineSnapshot;
  exhaustive: false;
}

export interface ProviderProvenance {
  role: "geocoding" | "routing" | "access" | "poi";
  provider: string;
  deployment: ProviderDeploymentKind;
  dataKind: ProviderDataKind;
  liveData: boolean;
  sourceUrl: string | null;
  license: SourceLicense | null;
  attribution: string;
  version: string;
  retrievedAt: string;
  notes: string;
  feeds: {
    mvg: FeedProvenance;
    mvv: FeedProvenance;
  } | null;
}

export interface MapConfigurationProvenance {
  source: "client-configured";
  styleUrl: string | null;
  attribution: string | null;
}

export interface ResolvedLocation extends MeetingLocation {
  source: string;
}

export interface OfficialBoundaryMetadata {
  name: string;
  sourceUrl: string;
  metadataUrl: string;
  retrievedAt: string;
  contentHash: string;
  metadataContentHash: string;
  districtCount: 25;
  license: SourceLicense;
  attribution: string;
  legalBoundary: false;
}

export type {
  AccessibleTargetInterval,
  AccessibleTargetVertex,
  AffineTimeSegment,
  EligibleRouteComponent,
  EligibleTargetComponent,
  CompleteRouteEnumeration,
  CompleteAlternateRegionCertificate,
  EnumerationCertificate,
  EnumeratedRoutePath,
  ExactInterval,
  ExactTemporalCorridor,
  TemporalCorridorOptions,
  FairRegion,
  FairRegionScope,
  FairVertexEvidence,
  FairEligibleTopologyInput,
  JourneyMidpoint,
  JourneyOccurrence,
  MeaningfulRouteFamily,
  MeetingTargetTopology,
  RouteFirstCalculationCompleteness,
  RouteFirstClientSubmission,
  RouteFirstClientParticipant,
  RouteFirstClientOrigin,
  RouteFirstClientJobEnvelope,
  RouteFirstClientJobStatus,
  RouteFirstClientResult,
  RouteFirstConditionalLandmark,
  RouteFirstEligibilityInput,
  RouteFirstEnumerationEvidence,
  RouteFirstEnumerationJob,
  RouteFirstFamilyContext,
  RouteFirstLandmarkEvaluation,
  RouteFirstMeetingCompleteResult,
  RouteFirstMeetingFamily,
  RouteFirstMeetingFailedResult,
  RouteFirstMeetingFailureCode,
  RouteFirstMeetingIncompleteResult,
  RouteFirstMeetingIncompleteReason,
  RouteFirstMeetingEnumerationProvider,
  RouteFirstMeetingMode,
  RouteFirstMeetingNoEligibleTargetResult,
  RouteFirstMeetingParticipant,
  RouteFirstMeetingProvenance,
  RouteFirstMeetingRequest,
  RouteFirstMeetingServiceResult,
  RouteFirstMeetingService,
  RouteFirstMeetingUnavailableResult,
  RouteFirstParticipantCorridor,
  RouteFirstFairRegionGeometry,
  RouteFirstAdmittedLandmark,
  RouteFirstAlternateEvidence,
  RouteFirstRoutingSnapshotProvenance,
  RouteFirstRoutingSnapshotSource,
  RouteEnumerationInput,
  RouteEnumerationPolicy,
  RouteEnumerationResult,
  RouteFamilyRequestContext,
  RouteGraph,
  RouteGraphEdge,
  RouteGraphVertex,
  RouteJourney,
  RouteJourneyRequestContext,
  RoutePathReference,
  RouteSnapshotIdentity,
  StationaryTargetOccurrence,
  TargetEdge,
  TargetTimeProfile,
  TargetVertex,
  TimedPathSegment,
  RouteFirstTrustedDataProvider,
  RouteFirstAssemblyContext,
  RouteFirstTrustedAssemblyResult,
} from "./route-first/index.ts";
