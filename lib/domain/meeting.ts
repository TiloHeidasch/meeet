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
} from "./types.ts";

const SAMPLE_GRID_APPROXIMATION_NOTICE =
  "Sample-grid approximation only: each returned clipped cell's center and declared clipped vertices passed the median ± tolerance rule and the official application boundary; cell interiors are not independently routed or proven comparable.";
const NO_CORRIDOR_MESSAGE =
  "No Munich grid cell had all five declared samples within the selected median ± tolerance window.";

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
  const metadata = createMetadata(providers, routingTiming);
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
          ? "Unofficial MVG routing (realtime when supplied; planned time fallback) + fixture coordinate resolution/static POIs"
          : dataKind === "demo-static"
          ? "Local static demo providers"
          : "Configured provider adapters",
    },
    approximation: SAMPLE_GRID_APPROXIMATION_NOTICE,
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
