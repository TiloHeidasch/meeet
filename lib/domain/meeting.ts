import {
  isPointInGeoJsonGeometry,
} from "./geo.ts";
import {
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "./boundary.ts";
import {
  createBoundedMunichGrid,
  GRID_COLUMNS,
  GRID_ROWS,
  MAX_ROUTING_MATRIX_ENTRIES,
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
): Promise<MeetingCalculationResponse> {
  const participants = await resolveParticipants(input.participants, providers);
  const grid = createBoundedMunichGrid();
  const matrixRequest: RoutingMatrixRequest = {
    participants: participants.map(toRoutingParticipant),
    destinations: grid.destinations,
    departureAt: input.departureAt,
  };

  if (
    matrixRequest.participants.length * matrixRequest.destinations.length >
    MAX_ROUTING_MATRIX_ENTRIES
  ) {
    throw new ProviderUnavailableError("routing");
  }

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
  const metadata = createMetadata(providers);
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
): MeetingCorridor {
  const properties: SampleGridCorridorProperties = {
    kind: "sample-grid-corridor",
    approximation: "sample-grid",
    verification: "center-and-clipped-vertices",
    tolerancePercent,
    cellCount: cells.length,
    gridColumns: GRID_COLUMNS,
    gridRows: GRID_ROWS,
    boundaryName: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
    geometryGuarantee: SAMPLE_GRID_APPROXIMATION_NOTICE,
  };
  const geometry: GeoJsonGeometry = {
    type: "MultiPolygon",
    coordinates: cells.flatMap((cell) => cell.geometry.coordinates),
  };

  return { type: "Feature", properties, geometry };
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
  response: {
    contractVersion: "meeet-routing-gateway/v1";
    departureAt: string;
    travelTimes: readonly RoutingMatrixCell[];
  },
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

function createMetadata(providers: MeetingProviders): MeetingCalculationMetadata {
  const descriptors = [
    providers.geocoding.descriptor,
    providers.routing.descriptor,
    providers.poi.descriptor,
  ];
  const dataKind = getOverallDataKind(descriptors);
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
      liveData: descriptors.some((descriptor) => descriptor.liveData),
      label:
        dataKind === "demo-static"
          ? "Local static demo providers"
          : "Configured provider adapters",
    },
    approximation: SAMPLE_GRID_APPROXIMATION_NOTICE,
    providers: {
      geocoding: providers.geocoding.descriptor,
      routing: providers.routing.descriptor,
      poi: providers.poi.descriptor,
    },
    boundary,
    provenance: {
      boundary,
      routing: providers.routing.descriptor.provenance,
      geocoding: providers.geocoding.descriptor.provenance,
      poi: providers.poi.descriptor.provenance,
      map: mapConfiguration,
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
