import {
  isPointInGeoJsonGeometry,
} from "./geo.ts";
import {
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "./boundary.ts";
import {
  createGridForRoutingCapabilities,
} from "./grid.ts";
import { createRouteCandidateSearchArea, ROUTE_CANDIDATE_BUFFER_RADIUS_METERS } from "./route-candidate-area.ts";
import { getMunichHubCandidates } from "./munich-hubs.ts";
import {
  deduplicateRouteCandidates,
  deriveRouteCandidates,
} from "./route-candidates.ts";
import type { MeetingProviders } from "./providers.ts";
import { MEETING_TIME_ZONE } from "./types.ts";
import type {
  ComparableTravelTimeRange,
  GeoJsonGeometry,
  GridCell,
  LocationCoordinate,
  MeetingCalculationInput,
  MeetingCalculationMetadata,
  MeetingCalculationNoCorridorResponse,
  MeetingCalculationOkResponse,
  MeetingCalculationResponse,
  MeetingCorridor,
  MeetingParticipant,
  ProviderDataKind,
  ProviderDeploymentKind,
  ProviderDescriptor,
  RoutingMatrixCell,
  RoutingMatrixRequest,
  RoutingMatrixResponse,
  RoutingMatrixTimingMetadata,
  RoutingProviderCapabilities,
  RoutingParticipant,
  SampleGridCorridorProperties,
  TolerancePercent,
  TravelTimeEstimate,
  RouteAlternative,
  RouteCandidate,
  RouteCandidateSearchArea,
  VerifiedMeetingCandidate,
} from "./types.ts";

const SAMPLE_GRID_APPROXIMATION_NOTICE =
  "Sample-grid approximation only: each returned clipped cell's center and declared clipped vertices passed the median ± tolerance rule and the official application boundary; cell interiors are not independently routed or proven comparable.";
const NO_CORRIDOR_MESSAGE =
  "No Munich grid cell had all five declared samples within the selected median ± tolerance window.";
const ROUTE_CANDIDATE_APPROXIMATION_NOTICE =
  "Route-candidate approximation only: returned candidate centers were routed for every participant and passed the median ± tolerance rule; the 350m POI buffers are clipped to the official Munich application boundary but their interiors are not independently routed or proven comparable.";
const NO_ROUTE_CANDIDATE_MESSAGE =
  "No returned MVG route candidate or explicit Munich hub had all participants within the selected median ± tolerance window.";
const MAX_ROUTE_CANDIDATES = 10;

export class ProviderUnavailableError extends Error {
  readonly providerRole: "geocoding" | "routing" | "poi";

  constructor(providerRole: "geocoding" | "routing" | "poi") {
    super(`The ${providerRole} provider is unavailable.`);
    this.name = "ProviderUnavailableError";
    this.providerRole = providerRole;
  }
}

export class ProviderNotConfiguredError extends Error {
  readonly providerRole: "geocoding" | "routing" | "poi";

  constructor(providerRole: "geocoding" | "routing" | "poi") {
    super(`The ${providerRole} provider is not configured.`);
    this.name = "ProviderNotConfiguredError";
    this.providerRole = providerRole;
  }
}

export class InvalidRoutingRequestError extends Error {
  readonly issues: readonly {
    path: Array<string | number>;
    code: string;
    message: string;
  }[];

  constructor(
    message: string,
    issues: readonly {
      path: Array<string | number>;
      code: string;
      message: string;
    }[],
  ) {
    super(message);
    this.name = "InvalidRoutingRequestError";
    this.issues = issues;
  }
}

export class ResolvedLocationOutsideMunichError extends Error {
  constructor() {
    super("The resolved location is outside the official Munich application boundary.");
    this.name = "ResolvedLocationOutsideMunichError";
  }
}

interface VerifiedGridCell {
  cell: GridCell;
  sampleRanges: readonly ComparableTravelTimeRange[];
}

export async function calculateMeeting(
  input: MeetingCalculationInput,
  providers: MeetingProviders,
  signal?: AbortSignal,
): Promise<MeetingCalculationResponse> {
  if (providers.routeAlternatives) {
    validateRouteCandidateRequest(input, providers.routing.capabilities);
    const participants = await resolveParticipants(input.participants, providers);
    return calculateRouteCandidateMeeting(
      input,
      providers,
      participants,
      providers.routeAlternatives,
      signal,
    );
  }

  const capabilities = providers.routing.capabilities;
  const grid = selectRoutingGrid(capabilities);
  validateRoutingRequest(input, capabilities, grid.destinations.length);
  const participants = await resolveParticipants(input.participants, providers);
  const matrixRequest: RoutingMatrixRequest = {
    participants: participants.map(toRoutingParticipant),
    destinations: grid.destinations,
    departureAt: input.departureAt,
    signal,
  };

  const matrix = await invokeProvider("routing", () =>
    providers.routing.getTravelTimeMatrix(matrixRequest),
  );
  const matrixByKey = validateAndIndexMatrix(matrix, matrixRequest);
  const verifiedCells = findVerifiedCells(
    grid.cells,
    matrixByKey,
    participants,
    input.tolerancePercent,
  );
  const routingTiming = matrix.timing ??
    (providers.routing.descriptor.provenance.provider === "mvg-direct-routing"
      ? { dataKind: "scheduled" as const, liveData: false }
      : undefined);
  const metadata = createMetadata(providers, routingTiming, "sample-grid");
  const requestSnapshot = createRequestSnapshot(input, participants);

  if (verifiedCells.length === 0) {
    const noCorridor: MeetingCalculationNoCorridorResponse = {
      status: "no-corridor",
      reason: {
        code: "NO_COMPARABLE_GRID_CELL",
        message: NO_CORRIDOR_MESSAGE,
      },
      requestSnapshot,
      metadata,
    };
    return noCorridor;
  }

  const representative = chooseRepresentativeCell(verifiedCells, participants);
  const representativeDestinationId = representative.cell.sampleDestinationIds[0];
  const representativeTimes = getTravelTimesForDestination(
    representativeDestinationId,
    participants,
    matrixByKey,
  );
  const corridor = createCorridor(
    verifiedCells.map(({ cell }) => cell),
    input.tolerancePercent,
    grid,
  );
  const pois = await invokeProvider("poi", () =>
    providers.poi.findFoodAndDrink(corridor.geometry),
  );
  const containedPois = pois.filter((poi) =>
    isPointInGeoJsonGeometry(poi.coordinates, corridor.geometry),
  );
  const ok: MeetingCalculationOkResponse = {
    status: "ok",
    meetingPoint: representative.cell.center,
    corridor,
    travelTimeRange: calculateComparableTravelTimeRange(
      representativeTimes.map((travelTime) => travelTime.minutes),
      input.tolerancePercent,
    ),
    travelTimes: representativeTimes,
    pois: containedPois,
    requestSnapshot,
    metadata,
  };
  return ok;
}

async function calculateRouteCandidateMeeting(
  input: MeetingCalculationInput,
  providers: MeetingProviders,
  participants: readonly MeetingParticipant[],
  alternativeProvider: NonNullable<MeetingProviders["routeAlternatives"]>,
  signal?: AbortSignal,
): Promise<MeetingCalculationResponse> {
  const first = participants[0];
  const second = participants[1];
  const [forward, reverse] = await invokeProvider("routing", () =>
    Promise.all([
      alternativeProvider.discoverRouteAlternatives({
        origin: first.location,
        destination: second.location,
        departureAt: input.departureAt,
        signal,
      }),
      alternativeProvider.discoverRouteAlternatives({
        origin: second.location,
        destination: first.location,
        departureAt: input.departureAt,
        signal,
      }),
    ]),
  );
  const destinations = createRouteCandidateDestinations([
    ...forward.alternatives,
    ...reverse.alternatives,
  ]);
  validateRoutingRequest(input, providers.routing.capabilities, destinations.length);

  const matrixRequest: RoutingMatrixRequest = {
    participants: participants.map(toRoutingParticipant),
    destinations: destinations.map((candidate) => ({
      id: candidate.id,
      coordinate: candidate.coordinate,
      sampleKind: "center" as const,
    })),
    departureAt: input.departureAt,
    signal,
  };
  const matrix = await invokeProvider("routing", () =>
    providers.routing.getTravelTimeMatrix(matrixRequest),
  );
  const matrixByKey = validateAndIndexMatrix(matrix, matrixRequest);
  const verified = findVerifiedRouteCandidates(
    destinations,
    matrixByKey,
    participants,
    input.tolerancePercent,
  ).sort(compareRouteCandidateVerification);
  const routingTiming = matrix.timing ??
    (providers.routing.descriptor.provenance.provider === "mvg-direct-routing"
      ? { dataKind: "scheduled" as const, liveData: false }
      : undefined);
  const metadata = createMetadata(providers, routingTiming, "route-candidate");
  const requestSnapshot = createRequestSnapshot(input, participants);

  if (verified.length === 0) {
    const noCorridor: MeetingCalculationNoCorridorResponse = {
      status: "no-corridor",
      reason: {
        code: "NO_COMPARABLE_ROUTE_CANDIDATE",
        message: NO_ROUTE_CANDIDATE_MESSAGE,
      },
      requestSnapshot,
      metadata,
    };
    return noCorridor;
  }

  const representative = verified[0];
  const corridor = createRouteCandidateCorridor(verified, input.tolerancePercent);
  const pois = await invokeProvider("poi", () =>
    providers.poi.findFoodAndDrink(corridor.geometry),
  );
  const containedPois = pois.filter((poi) =>
    isPointInGeoJsonGeometry(poi.coordinates, corridor.geometry),
  );
  const ok: MeetingCalculationOkResponse = {
    status: "ok",
    meetingPoint: representative.candidate.coordinate,
    corridor,
    travelTimeRange: representative.travelTimeRange,
    travelTimes: representative.travelTimes,
    pois: containedPois,
    candidates: verified.map(toVerifiedMeetingCandidate),
    requestSnapshot,
    metadata,
  };
  return ok;
}

function validateRouteCandidateRequest(
  input: MeetingCalculationInput,
  capabilities: RoutingProviderCapabilities,
): void {
  const issues: Array<{ path: Array<string | number>; code: string; message: string }> = [];
  for (const index of [0, 1]) {
    if (input.participants[index]?.mode !== "transit") {
      issues.push({
        path: ["participants", index, "mode"],
        code: "route_candidate_anchor_mode_unsupported",
        message: "The first two participants must use public transport for route-candidate search.",
      });
    }
  }
  if (issues.length > 0) {
    throw new InvalidRoutingRequestError(
      "The first two participants must use public transport for route-candidate search.",
      issues,
    );
  }
  validateRoutingRequest(input, capabilities, 1);
}

function createRouteCandidateDestinations(
  alternatives: readonly RouteAlternative[],
): readonly RouteCandidate[] {
  const routeCandidates = deriveRouteCandidates(alternatives).filter((candidate) =>
    isWithinOfficialMunichBoundary(candidate.coordinate),
  );
  const hubs = getMunichHubCandidates().filter((candidate) =>
    isWithinOfficialMunichBoundary(candidate.coordinate),
  );
  const unique = deduplicateRouteCandidates([...hubs, ...routeCandidates]);
  const hubIds = new Set(hubs.map((hub) => hub.id));
  const ordered = [
    ...unique.filter((candidate) => hubIds.has(candidate.id)),
    ...unique.filter((candidate) => !hubIds.has(candidate.id)),
  ];
  return ordered.slice(0, MAX_ROUTE_CANDIDATES);
}

interface RouteCandidateVerification {
  candidate: RouteCandidate;
  travelTimeRange: ComparableTravelTimeRange;
  travelTimes: readonly TravelTimeEstimate[];
  normalizedSpread: number;
  maxTravelMinutes: number;
}

function findVerifiedRouteCandidates(
  candidates: readonly RouteCandidate[],
  matrixByKey: ReadonlyMap<string, RoutingMatrixCell>,
  participants: readonly MeetingParticipant[],
  tolerancePercent: TolerancePercent,
): RouteCandidateVerification[] {
  return candidates.flatMap((candidate) => {
    const cells = participants.map((participant) =>
      getMatrixCell(participant.id, candidate.id, matrixByKey),
    );
    if (cells.some((cell) => cell.status === "unreachable" || cell.minutes === null)) {
      return [];
    }
    const minutes = cells.map((cell) => cell.minutes as number);
    const travelTimeRange = calculateComparableTravelTimeRange(minutes, tolerancePercent);
    if (!travelTimeRange.isComparable) return [];
    const maxTravelMinutes = travelTimeRange.observedMaxMinutes;
    const normalizedSpread = travelTimeRange.targetMinutes === 0
      ? maxTravelMinutes === 0 ? 0 : Number.POSITIVE_INFINITY
      : (travelTimeRange.observedMaxMinutes - travelTimeRange.observedMinMinutes) /
        travelTimeRange.targetMinutes;
    return [{
      candidate,
      travelTimeRange,
      travelTimes: cells.map((cell) => ({
        participantId: cell.participantId,
        mode: cell.mode,
        minutes: cell.minutes as number,
        source: cell.source,
      })),
      normalizedSpread,
      maxTravelMinutes,
    }];
  });
}

function compareRouteCandidateVerification(
  left: RouteCandidateVerification,
  right: RouteCandidateVerification,
): number {
  return left.normalizedSpread - right.normalizedSpread ||
    left.maxTravelMinutes - right.maxTravelMinutes ||
    left.candidate.id.localeCompare(right.candidate.id);
}

function createRouteCandidateCorridor(
  verified: readonly RouteCandidateVerification[],
  tolerancePercent: TolerancePercent,
): RouteCandidateSearchArea {
  const properties = {
    kind: "route-candidate-search-area" as const,
    approximation: "route-candidate-search" as const,
    verification: "candidate-centers-routed" as const,
    tolerancePercent,
    cellCount: verified.length,
    candidateCount: verified.length,
    bufferRadiusMeters: ROUTE_CANDIDATE_BUFFER_RADIUS_METERS,
    boundaryName: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
    geometryGuarantee: ROUTE_CANDIDATE_APPROXIMATION_NOTICE,
  };
  return {
    type: "Feature",
    properties,
    geometry: createRouteCandidateSearchArea(
      verified.map(({ candidate }) => candidate.coordinate),
    ),
  };
}

function toVerifiedMeetingCandidate(
  verification: RouteCandidateVerification,
): VerifiedMeetingCandidate {
  return {
    id: verification.candidate.id,
    kind: verification.candidate.kind,
    label: verification.candidate.label,
    coordinate: verification.candidate.coordinate,
    travelTimeRange: verification.travelTimeRange,
    travelTimes: verification.travelTimes,
    normalizedSpread: verification.normalizedSpread,
    maxTravelMinutes: verification.maxTravelMinutes,
  };
}

export function calculateComparableTravelTimeRange(
  minutes: readonly number[],
  tolerancePercent: TolerancePercent,
): ComparableTravelTimeRange {
  if (minutes.length === 0 || minutes.some((minute) => !Number.isFinite(minute))) {
    throw new RangeError("At least one finite travel time is required.");
  }

  const orderedMinutes = [...minutes].sort((first, second) => first - second);
  const middle = Math.floor(orderedMinutes.length / 2);
  const targetMinutes =
    orderedMinutes.length % 2 === 0
      ? (orderedMinutes[middle - 1] + orderedMinutes[middle]) / 2
      : orderedMinutes[middle];
  const tolerance = tolerancePercent / 100;
  const lowerMinutes = targetMinutes * (1 - tolerance);
  const upperMinutes = targetMinutes * (1 + tolerance);
  const observedMinMinutes = orderedMinutes[0];
  const observedMaxMinutes = orderedMinutes[orderedMinutes.length - 1];

  return {
    targetMinutes,
    lowerMinutes,
    upperMinutes,
    observedMinMinutes,
    observedMaxMinutes,
    tolerancePercent,
    isComparable:
      observedMinMinutes >= lowerMinutes && observedMaxMinutes <= upperMinutes,
  };
}

function toRoutingParticipant(
  participant: MeetingParticipant,
): RoutingParticipant {
  return {
    participantId: participant.id,
    origin: participant.location,
    mode: participant.mode,
  };
}

async function resolveParticipants(
  participants: readonly MeetingParticipant[],
  providers: MeetingProviders,
): Promise<readonly MeetingParticipant[]> {
  return Promise.all(
    participants.map(async (participant) => {
      const location = await invokeProvider("geocoding", () =>
        providers.geocoding.resolveLocation(participant.location),
      );
      if (
        !Number.isFinite(location.latitude) ||
        !Number.isFinite(location.longitude) ||
        !isWithinOfficialMunichBoundary(location)
      ) {
        throw new ResolvedLocationOutsideMunichError();
      }
      return {
        ...participant,
        location: {
          label: location.label,
          latitude: location.latitude,
          longitude: location.longitude,
        },
      };
    }),
  );
}

function findVerifiedCells(
  cells: readonly GridCell[],
  matrixByKey: ReadonlyMap<string, RoutingMatrixCell>,
  participants: readonly MeetingParticipant[],
  tolerancePercent: TolerancePercent,
): readonly VerifiedGridCell[] {
  return cells.flatMap((cell) => {
    const sampleRanges = cell.sampleDestinationIds.flatMap((destinationId) => {
      const matrixCells = participants.map((participant) =>
        getMatrixCell(participant.id, destinationId, matrixByKey),
      );
      if (
        matrixCells.some(
          (matrixCell) => matrixCell.status === "unreachable" || matrixCell.minutes === null,
        )
      ) {
        return [];
      }
      return [
        calculateComparableTravelTimeRange(
          matrixCells.map((matrixCell) => matrixCell.minutes as number),
          tolerancePercent,
        ),
      ];
    });
    return sampleRanges.length === cell.sampleDestinationIds.length &&
      sampleRanges.every((range) => range.isComparable)
      ? [{ cell, sampleRanges }]
      : [];
  });
}

function createCorridor(
  cells: readonly GridCell[],
  tolerancePercent: TolerancePercent,
  grid: { columns: number; rows: number },
): MeetingCorridor {
  const properties: SampleGridCorridorProperties = {
    kind: "sample-grid-corridor",
    approximation: "sample-grid",
    verification: "center-and-clipped-vertices",
    tolerancePercent,
    cellCount: cells.length,
    gridColumns: grid.columns,
    gridRows: grid.rows,
    boundaryName: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
    geometryGuarantee: SAMPLE_GRID_APPROXIMATION_NOTICE,
  };
  const geometry: GeoJsonGeometry = {
    type: "MultiPolygon",
    coordinates: cells.flatMap((cell) => cell.geometry.coordinates),
  };

  return { type: "Feature", properties, geometry };
}

function selectRoutingGrid(
  capabilities: RoutingProviderCapabilities,
) {
  try {
    return createGridForRoutingCapabilities(capabilities);
  } catch {
    throw new InvalidRoutingRequestError(
      "The selected routing provider cannot serve a complete bounded Munich grid.",
      [
        {
          path: ["participants"],
          code: "routing_grid_exceeds_provider_cap",
          message: "The selected provider cannot serve a complete grid for this request.",
        },
      ],
    );
  }
}

function validateRoutingRequest(
  input: MeetingCalculationInput,
  capabilities: RoutingProviderCapabilities,
  destinationCount: number,
): void {
  const issues: Array<{ path: Array<string | number>; code: string; message: string }> = [];
  if (input.participants.length > capabilities.maxParticipants) {
    issues.push({
      path: ["participants"],
      code: "routing_provider_participant_cap",
      message: `The selected routing provider supports at most ${capabilities.maxParticipants} participants.`,
    });
  }
  input.participants.forEach((participant, index) => {
    if (!capabilities.supportedModes.includes(participant.mode)) {
      issues.push({
        path: ["participants", index, "mode"],
        code: "routing_mode_unsupported",
        message: `The selected routing provider does not support ${participant.mode} travel.`,
      });
    }
  });
  if (destinationCount > capabilities.maxDestinations) {
    issues.push({
      path: ["participants"],
      code: "routing_provider_destination_cap",
      message: `The selected routing provider supports at most ${capabilities.maxDestinations} destinations.`,
    });
  }
  const entries = input.participants.length * destinationCount;
  if (entries > capabilities.maxMatrixEntries) {
    issues.push({
      path: ["participants"],
      code: "routing_provider_matrix_cap",
      message: `The selected routing provider supports at most ${capabilities.maxMatrixEntries} matrix entries.`,
    });
  }
  if (issues.length > 0) {
    throw new InvalidRoutingRequestError(
      "The request exceeds the selected routing provider capabilities.",
      issues,
    );
  }
}

function chooseRepresentativeCell(
  cells: readonly VerifiedGridCell[],
  participants: readonly MeetingParticipant[],
): VerifiedGridCell {
  const average = participants.reduce(
    (sum, participant) => ({
      latitude: sum.latitude + participant.location.latitude / participants.length,
      longitude: sum.longitude + participant.location.longitude / participants.length,
    }),
    { latitude: 0, longitude: 0 },
  );
  return cells.reduce((best, current) =>
    coordinateDistanceSquared(current.cell.center, average) <
    coordinateDistanceSquared(best.cell.center, average)
      ? current
      : best,
  );
}

function getTravelTimesForDestination(
  destinationId: string,
  participants: readonly MeetingParticipant[],
  matrixByKey: ReadonlyMap<string, RoutingMatrixCell>,
): readonly TravelTimeEstimate[] {
  return participants.map((participant) => {
    const cell = getMatrixCell(participant.id, destinationId, matrixByKey);
    if (cell.status !== "ok" || cell.minutes === null) {
      throw new ProviderUnavailableError("routing");
    }
    return {
      participantId: cell.participantId,
      mode: cell.mode,
      minutes: cell.minutes,
      source: cell.source,
    };
  });
}

function getMatrixCell(
  participantId: string,
  destinationId: string,
  matrixByKey: ReadonlyMap<string, RoutingMatrixCell>,
): RoutingMatrixCell {
  const matrixCell = matrixByKey.get(matrixKey(participantId, destinationId));
  if (!matrixCell) {
    throw new ProviderUnavailableError("routing");
  }
  return matrixCell;
}

function validateAndIndexMatrix(
  response: RoutingMatrixResponse,
  request: RoutingMatrixRequest,
): ReadonlyMap<string, RoutingMatrixCell> {
  if (
    response.contractVersion !== "meeet-routing-gateway/v1" ||
    response.departureAt !== request.departureAt ||
    response.travelTimes.length !==
      request.participants.length * request.destinations.length
  ) {
    throw new ProviderUnavailableError("routing");
  }

  const participantModes = new Map(
    request.participants.map((participant) => [
      participant.participantId,
      participant.mode,
    ]),
  );
  const destinationIds = new Set(
    request.destinations.map((destination) => destination.id),
  );
  const matrixByKey = new Map<string, RoutingMatrixCell>();
  for (const cell of response.travelTimes) {
    if (
      !participantModes.has(cell.participantId) ||
      participantModes.get(cell.participantId) !== cell.mode ||
      !destinationIds.has(cell.destinationId) ||
      (cell.status === "ok" &&
        (cell.minutes === null ||
          !Number.isFinite(cell.minutes) ||
          cell.minutes < 0)) ||
      (cell.status === "unreachable" && cell.minutes !== null) ||
      cell.status !== "ok" && cell.status !== "unreachable"
    ) {
      throw new ProviderUnavailableError("routing");
    }
    const key = matrixKey(cell.participantId, cell.destinationId);
    if (matrixByKey.has(key)) {
      throw new ProviderUnavailableError("routing");
    }
    matrixByKey.set(key, cell);
  }
  return matrixByKey;
}

function matrixKey(participantId: string, destinationId: string): string {
  return `${participantId}\u0000${destinationId}`;
}

function createRequestSnapshot(
  input: MeetingCalculationInput,
  participants: readonly MeetingParticipant[],
) {
  return {
    participants,
    tolerancePercent: input.tolerancePercent,
    departureAt: input.departureAt,
    timeZone: MEETING_TIME_ZONE,
  };
}

function createMetadata(
  providers: MeetingProviders,
  routingTiming?: RoutingMatrixTimingMetadata,
  searchKind: "sample-grid" | "route-candidate" = "sample-grid",
): MeetingCalculationMetadata {
  const routing = applyRoutingTiming(providers.routing.descriptor, routingTiming);
  const descriptors = [
    providers.geocoding.descriptor,
    routing,
    providers.poi.descriptor,
  ];
  const dataKind = routingTiming
    ? routingTiming.liveData
      ? "live"
      : "scheduled"
    : getOverallDataKind(descriptors);
  const deployment = getOverallDeployment(descriptors);
  const mapConfiguration = providers.mapConfiguration ?? {
    source: "client-configured" as const,
    styleUrl: null,
    attribution: null,
  };
  const boundary = {
    name: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
    sourceUrl: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.sourceUrl,
    metadataUrl: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.metadataUrl,
    retrievedAt: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.retrievedAt,
    contentHash: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.normalizedContentHash,
    metadataContentHash: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.metadataContentHash,
    districtCount: 25 as const,
    license: {
      name: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.license.name,
      url: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.license.url,
    },
    attribution: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.attribution,
    legalBoundary: false as const,
  };

  return {
    source: {
      deployment,
      dataKind,
      liveData: routingTiming?.liveData ?? descriptors.some((descriptor) => descriptor.liveData),
      label:
        routing.provenance.provider === "mvg-direct-routing"
          ? "Unofficial MVG routing with candidate centers + fixture coordinate resolution/static POIs"
          : dataKind === "demo-static"
          ? "Local static demo providers"
          : "Configured provider adapters",
    },
    approximation: searchKind === "route-candidate"
      ? ROUTE_CANDIDATE_APPROXIMATION_NOTICE
      : SAMPLE_GRID_APPROXIMATION_NOTICE,
    providers: {
      geocoding: providers.geocoding.descriptor,
      routing,
      poi: providers.poi.descriptor,
    },
    boundary,
    provenance: {
      boundary,
      routing: routing.provenance,
      geocoding: providers.geocoding.descriptor.provenance,
      poi: providers.poi.descriptor.provenance,
      map: mapConfiguration,
    },
  };
}

function applyRoutingTiming(
  descriptor: ProviderDescriptor,
  timing?: RoutingMatrixTimingMetadata,
): ProviderDescriptor {
  if (!timing) return descriptor;
  const dataKind = timing.liveData ? "live" : "scheduled";
  return {
    ...descriptor,
    dataKind,
    liveData: timing.liveData,
    provenance: {
      ...descriptor.provenance,
      dataKind,
      liveData: timing.liveData,
    },
  };
}

function getOverallDataKind(
  descriptors: readonly ProviderDescriptor[],
): ProviderDataKind {
  const first = descriptors[0]?.dataKind;
  return first && descriptors.every((descriptor) => descriptor.dataKind === first)
    ? first
    : "unknown";
}

function getOverallDeployment(
  descriptors: readonly ProviderDescriptor[],
): ProviderDeploymentKind {
  const first = descriptors[0]?.deployment;
  return first && descriptors.every((descriptor) => descriptor.deployment === first)
    ? first
    : "unknown";
}

async function invokeProvider<T>(
  providerRole: "geocoding" | "routing" | "poi",
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      throw error;
    }
    if (error instanceof ProviderNotConfiguredError) {
      throw error;
    }
    throw new ProviderUnavailableError(providerRole);
  }
}

function coordinateDistanceSquared(
  first: LocationCoordinate,
  second: LocationCoordinate,
): number {
  return (
    (first.latitude - second.latitude) ** 2 +
    (first.longitude - second.longitude) ** 2
  );
}
