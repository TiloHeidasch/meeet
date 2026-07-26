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

/** Normalized server input. `departureAt` is always resolved before calculation. */
export interface MeetingCalculationInput {
  participants: readonly MeetingParticipant[];
  tolerancePercent: TolerancePercent;
  departureAt: string;
}

export type GeoJsonPosition = [number, number];

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: GeoJsonPosition[][];
}

export interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: GeoJsonPosition[][][];
}

export type GeoJsonGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

export interface GeoJsonFeature<
  Geometry extends GeoJsonGeometry,
  Properties extends Record<string, unknown>,
> {
  type: "Feature";
  properties: Properties;
  geometry: Geometry;
}

export interface SampleGridCorridorProperties extends Record<string, unknown> {
  kind: "sample-grid-corridor";
  approximation: "sample-grid";
  verification: "center-and-clipped-vertices";
  tolerancePercent: TolerancePercent;
  cellCount: number;
  gridColumns: number;
  gridRows: number;
  boundaryName: string;
  geometryGuarantee: string;
}

export type MeetingCorridor = GeoJsonFeature<
  GeoJsonMultiPolygon,
  SampleGridCorridorProperties
>;

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

export interface RoutingMatrixResponse {
  contractVersion: "meeet-routing-gateway/v1";
  departureAt: string;
  travelTimes: readonly RoutingMatrixCell[];
}

export interface RoutingProviderCapabilities {
  supportedModes: readonly TravelMode[];
  maxParticipants: number;
  maxDestinations: number;
  maxMatrixEntries: number;
}

export interface ComparableTravelTimeRange {
  targetMinutes: number;
  lowerMinutes: number;
  upperMinutes: number;
  observedMinMinutes: number;
  observedMaxMinutes: number;
  tolerancePercent: TolerancePercent;
  isComparable: boolean;
}

export interface GridCell {
  id: string;
  row: number;
  column: number;
  center: LocationCoordinate;
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

export interface TravelTimeEstimate {
  participantId: string;
  mode: TravelMode;
  minutes: number;
  source: string;
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

export interface ProviderProvenance {
  role: "geocoding" | "routing" | "poi";
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

export interface MeetingRequestSnapshot {
  participants: readonly MeetingParticipant[];
  tolerancePercent: TolerancePercent;
  departureAt: string;
  timeZone: MeetingTimeZone;
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

export interface MeetingCalculationMetadata {
  source: {
    deployment: ProviderDeploymentKind;
    dataKind: ProviderDataKind;
    liveData: boolean;
    label: string;
  };
  approximation: string;
  providers: {
    geocoding: ProviderDescriptor;
    routing: ProviderDescriptor;
    poi: ProviderDescriptor;
  };
  boundary: OfficialBoundaryMetadata;
  provenance: {
    boundary: OfficialBoundaryMetadata;
    routing: ProviderProvenance;
    geocoding: ProviderProvenance;
    poi: ProviderProvenance;
    map: MapConfigurationProvenance;
  };
}

export interface MeetingCalculationOkResponse {
  status: "ok";
  meetingPoint: LocationCoordinate;
  corridor: MeetingCorridor;
  travelTimeRange: ComparableTravelTimeRange;
  travelTimes: readonly TravelTimeEstimate[];
  pois: readonly MeetingPointOfInterest[];
  requestSnapshot: MeetingRequestSnapshot;
  metadata: MeetingCalculationMetadata;
}

export interface NoCorridorReason {
  code: "NO_COMPARABLE_GRID_CELL";
  message: string;
}

export interface MeetingCalculationNoCorridorResponse {
  status: "no-corridor";
  reason: NoCorridorReason;
  requestSnapshot: MeetingRequestSnapshot;
  metadata: MeetingCalculationMetadata;
}

export type MeetingCalculationResponse =
  | MeetingCalculationOkResponse
  | MeetingCalculationNoCorridorResponse;
