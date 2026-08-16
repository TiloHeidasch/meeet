import "server-only";

import type { BoundedMunichGrid } from "../types.ts";
import { ProviderNotConfiguredError, ProviderUnavailableError, type ScheduledAccessSeedProvider, type ScheduledAccessSeedCandidate } from "../providers.ts";
import { calculateScheduledSurface } from "./surface.ts";
import { createScheduledSurfaceGrid, deriveInteriorRepresentativePoint } from "./grid.ts";
import {
  DEFAULT_TRANSFER_RADIUS_METERS,
  DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
} from "./router.ts";
import type {
  ScheduledAccessSeed,
  ScheduledRoutingArtifact,
  ScheduledSurfaceCell,
  ScheduledDeadlineCheck,
} from "./models.ts";
import type { ScheduledMeetingRequest, ScheduledMeetingParticipantInput } from "../../validation/meeting-v3.ts";
import type {
  ScheduledMeetingCellDto,
  ScheduledMeetingStationAreaDto,
  ScheduledMeetingParticipantDto,
  ScheduledMeetingResponseDto,
} from "../../validation/meeting-v3.ts";

const MEETING_RESULT_CHECKPOINT = 32;

export interface ScheduledMeetingProviderBundle {
  readonly artifact?: ScheduledRoutingArtifact;
  readonly access?: ScheduledAccessSeedProvider;
  readonly grid?: BoundedMunichGrid;
  readonly walkingVelocityMetersPerSecond?: number;
  readonly transferRadiusMeters?: number;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export type ScheduledParticipantResponse = ScheduledMeetingParticipantDto;
export type ScheduledMeetingCellResponse = ScheduledMeetingCellDto;
export type ScheduledMeetingStationAreaResponse = ScheduledMeetingStationAreaDto;
export type ScheduledMeetingResponse = ScheduledMeetingResponseDto;

export interface ScheduledCalculationBasis {
  readonly canonicalRequest: ScheduledMeetingRequest;
  /** Exact seeds consumed by the v3 surface; never substitute provider coordinates. */
  readonly canonicalAccessSeeds: readonly [readonly ScheduledAccessSeed[], readonly ScheduledAccessSeed[]];
  /** Ordered provider results retained only for selected-route access evidence. */
  readonly accessSeedCandidates: readonly [readonly ScheduledAccessSeedCandidate[], readonly ScheduledAccessSeedCandidate[]];
  readonly artifactIdentity: {
    readonly contractVersion: string;
    readonly feedId: string;
    readonly timeZone: string;
    readonly scheduleContentHash: string;
    readonly compiledArtifactId: string;
  };
  readonly routingOptions: {
    readonly routingHorizonSeconds: number;
    readonly walkingVelocityMetersPerSecond: number;
    readonly walkingSecondsRoundingRule: string;
    readonly transferRadiusMeters: number;
  };
  readonly scheduleProvenance: ScheduledMeetingResponseDto["metadata"]["schedule"];
  readonly accessProvenance: ScheduledMeetingResponseDto["metadata"]["accessProvider"];
  readonly status: ScheduledMeetingResponseDto["status"];
  readonly reason: ScheduledMeetingResponseDto["reason"];
  readonly stationAreas: readonly ScheduledMeetingStationAreaDto[];
}

export interface ScheduledMeetingCalculation {
  readonly response: ScheduledMeetingResponse;
  readonly basis: ScheduledCalculationBasis;
}

export async function calculateScheduledMeeting(
  request: ScheduledMeetingRequest,
  providers: ScheduledMeetingProviderBundle,
  signal?: AbortSignal,
): Promise<ScheduledMeetingResponse> {
  const calculation = await calculateScheduledMeetingWithBasis(request, providers, signal);
  return calculation.response;
}

export async function calculateScheduledMeetingWithBasis(
  request: ScheduledMeetingRequest,
  providers: ScheduledMeetingProviderBundle,
  signal?: AbortSignal,
): Promise<ScheduledMeetingCalculation> {
  providers.deadlineCheck?.("meeting-start");
  const artifact = providers.artifact;
  if (artifact === undefined) throw new ProviderNotConfiguredError("routing");
  const access = providers.access;
  if (access === undefined) throw new ProviderNotConfiguredError("routing");
  if (signal?.aborted) throw new ProviderUnavailableError("routing");
  const grid = providers.grid ?? createScheduledSurfaceGrid();
  const walkingVelocityMetersPerSecond = providers.walkingVelocityMetersPerSecond ?? DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND;
  const transferRadiusMeters = providers.transferRadiusMeters ?? DEFAULT_TRANSFER_RADIUS_METERS;
  let seedSets: [readonly ScheduledAccessSeedCandidate[], readonly ScheduledAccessSeedCandidate[]];
  try {
    const resolvedSeeds = await Promise.all(request.participants.map((participant) => access.resolveAccessSeeds({
      origin: participant.origin,
      schedule: artifact,
      signal,
    })));
    seedSets = [resolvedSeeds[0] ?? [], resolvedSeeds[1] ?? []];
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError || error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError("routing");
  }
  providers.deadlineCheck?.("meeting-access");
  const scheduledSeedSets: [readonly ScheduledAccessSeed[], readonly ScheduledAccessSeed[]] = [
    seedSets[0].map(toScheduledAccessSeed),
    seedSets[1].map(toScheduledAccessSeed),
  ];
  providers.deadlineCheck?.("meeting-surface");
  const surfaceCells = grid.cells.map(toSurfaceCell);
  const surfaceCellById = new Map(surfaceCells.map((cell) => [cell.id, cell]));
  const surface = calculateScheduledSurface({
    schedule: artifact,
    accessSeedSets: scheduledSeedSets,
    searchStartAt: request.searchStartAt,
    selectedTolerancePercent: request.tolerancePercent,
    cells: surfaceCells,
    walkingVelocityMetersPerSecond,
    transferRadiusMeters,
    participantIds: [request.participants[0].id, request.participants[1].id],
    deadlineCheck: providers.deadlineCheck,
  });
  providers.deadlineCheck?.("meeting-surface");
  const classificationById = new Map(surface.cells.map((cell) => [cell.cellId, cell]));
  const cells = grid.cells.map((cell) => {
    const classification = classificationById.get(cell.id);
    if (classification === undefined) throw new Error(`Scheduled surface lost grid cell ${cell.id}.`);
    const surfaceCell = surfaceCellById.get(cell.id);
    if (surfaceCell === undefined) throw new Error(`Scheduled surface lost grid cell ${cell.id}.`);
    return {
      id: cell.id,
      geometry: cell.geometry,
      representativePoint: surfaceCell.representativePoint,
      classification: classification.classification,
      redArrivalSeconds: classification.redArrivalSeconds,
      blueArrivalSeconds: classification.blueArrivalSeconds,
      fasterParticipant: classification.fasterParticipant,
      withinSelectedTolerance: classification.withinSelectedTolerance,
    };
  });
  const stationAreas = surface.stationAreas.map((candidate, index) => {
    if (index % MEETING_RESULT_CHECKPOINT === 0) providers.deadlineCheck?.("meeting-result");
    return {
      stationAreaId: candidate.stationAreaId,
      name: candidate.name,
      coordinate: candidate.coordinate,
      redBoardingStopId: candidate.redBoardingStopId,
      blueBoardingStopId: candidate.blueBoardingStopId,
      classification: candidate.classification,
      redArrivalSeconds: candidate.redArrivalSeconds,
      blueArrivalSeconds: candidate.blueArrivalSeconds,
      fasterParticipant: candidate.fasterParticipant,
      withinSelectedTolerance: candidate.withinSelectedTolerance,
    };
  });
  providers.deadlineCheck?.("meeting-result");
  const response: ScheduledMeetingResponse = deepFreeze({
    contractVersion: "meeet-meeting/v3",
    status: surface.status,
    reason: surface.status === "no-result" ? surface.reason : null,
    participants: [
      participantResponse(request.participants[0], "red", seedSets[0]),
      participantResponse(request.participants[1], "blue", seedSets[1]),
    ],
    cells,
    stationAreas,
    metadata: {
      schedule: {
        contractVersion: artifact.contractVersion,
        feedId: artifact.feedId,
        timeZone: artifact.timeZone,
        scheduleContentHash: artifact.provenance.contentHash,
        compiledArtifactId: artifact.provenance.compiledArtifactId,
        serviceDateRange: artifact.serviceDateRange,
        acquisition: artifact.provenance.acquisition,
      },
      surface: {
        ...surface.metadata,
        classificationMethod: "representative-point-with-geometric-final-station-walking/v1",
        classificationBasis: "representative-point",
        representativePointBasis: "inside-clipped-cell/v1",
        finalWalkingMethod: "geometric-station-walking-estimate-not-navigation",
      },
      grid: {
        columns: grid.columns,
        rows: grid.rows,
        cellCount: grid.cells.length,
        geometry: "munich-clipped-surface-grid/v1",
      },
      stationAreas: {
        count: stationAreas.length,
        coverage: "official-munich-boundary-with-connected-artifact-boarding-stops/v1",
        selection: "all-eligible-scheduled-station-areas/v1",
      },
      accessProvider: access.descriptor,
      coverage: "munich-clipped-scheduled-grid/v1",
    },
  });
  const basis: ScheduledCalculationBasis = {
    canonicalRequest: cloneRequest(request),
    canonicalAccessSeeds: [
      scheduledSeedSets[0].map(cloneScheduledAccessSeed),
      scheduledSeedSets[1].map(cloneScheduledAccessSeed),
    ],
    accessSeedCandidates: [
      seedSets[0].map(cloneAccessSeedCandidate),
      seedSets[1].map(cloneAccessSeedCandidate),
    ],
    artifactIdentity: {
      contractVersion: artifact.contractVersion,
      feedId: artifact.feedId,
      timeZone: artifact.timeZone,
      scheduleContentHash: artifact.provenance.contentHash,
      compiledArtifactId: artifact.provenance.compiledArtifactId,
    },
    routingOptions: {
      routingHorizonSeconds: surface.metadata.routingHorizonSeconds,
      walkingVelocityMetersPerSecond: surface.metadata.walkingVelocityMetersPerSecond,
      walkingSecondsRoundingRule: surface.metadata.walkingSecondsRoundingRule,
      transferRadiusMeters: surface.metadata.transferRadiusMeters,
    },
    scheduleProvenance: response.metadata.schedule,
    accessProvenance: response.metadata.accessProvider,
    status: response.status,
    reason: response.reason,
    stationAreas: response.stationAreas.map((stationArea) => ({ ...stationArea })),
  };
  return deepFreeze({ response, basis });
}

function participantResponse(
  participant: ScheduledMeetingParticipantInput,
  color: "red" | "blue",
  seeds: readonly ScheduledAccessSeedCandidate[],
): ScheduledParticipantResponse {
  return { id: participant.id, color, origin: participant.origin, mode: "transit", accessSeeds: seeds };
}

function toScheduledAccessSeed(candidate: ScheduledAccessSeedCandidate): ScheduledAccessSeed {
  return {
    stationAreaId: candidate.stationAreaId,
    ...(candidate.boardingStopId === undefined ? {} : { boardingStopId: candidate.boardingStopId }),
    accessSeconds: candidate.accessSeconds,
  };
}

function cloneScheduledAccessSeed(seed: ScheduledAccessSeed): ScheduledAccessSeed {
  return {
    stationAreaId: seed.stationAreaId,
    ...(seed.boardingStopId === undefined ? {} : { boardingStopId: seed.boardingStopId }),
    accessSeconds: seed.accessSeconds,
  };
}

function cloneAccessSeedCandidate(candidate: ScheduledAccessSeedCandidate): ScheduledAccessSeedCandidate {
  return {
    seedId: candidate.seedId,
    mvgStationId: candidate.mvgStationId,
    stationAreaId: candidate.stationAreaId,
    ...(candidate.boardingStopId === undefined ? {} : { boardingStopId: candidate.boardingStopId }),
    coordinate: { latitude: candidate.coordinate.latitude, longitude: candidate.coordinate.longitude },
    accessSeconds: candidate.accessSeconds,
    provenance: { ...candidate.provenance },
  };
}

function cloneRequest(request: ScheduledMeetingRequest): ScheduledMeetingRequest {
  return {
    contractVersion: "meeet-meeting/v3",
    participants: [
      { id: request.participants[0].id, mode: "transit", origin: { ...request.participants[0].origin } },
      { id: request.participants[1].id, mode: "transit", origin: { ...request.participants[1].origin } },
    ],
    tolerancePercent: request.tolerancePercent,
    searchStartAt: request.searchStartAt,
  };
}

function toSurfaceCell(cell: BoundedMunichGrid["cells"][number]): ScheduledSurfaceCell {
  return {
    id: cell.id,
    center: cell.center,
    representativePoint: deriveInteriorRepresentativePoint(cell.geometry, cell.center),
    geometry: cell.geometry,
  };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
