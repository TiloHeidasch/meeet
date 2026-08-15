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
  ScheduledMeetingParticipantDto,
  ScheduledMeetingResponseDto,
} from "../../validation/meeting-v3.ts";

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
export type ScheduledMeetingResponse = ScheduledMeetingResponseDto;

export async function calculateScheduledMeeting(
  request: ScheduledMeetingRequest,
  providers: ScheduledMeetingProviderBundle,
  signal?: AbortSignal,
): Promise<ScheduledMeetingResponse> {
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
  providers.deadlineCheck?.("meeting-result");
  return deepFreeze({
    contractVersion: "meeet-meeting/v3",
    status: surface.status,
    reason: surface.status === "no-result" ? surface.reason : null,
    participants: [
      participantResponse(request.participants[0], "red", seedSets[0]),
      participantResponse(request.participants[1], "blue", seedSets[1]),
    ],
    cells,
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
      accessProvider: access.descriptor,
      coverage: "munich-clipped-scheduled-grid/v1",
    },
  });
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

function toSurfaceCell(cell: BoundedMunichGrid["cells"][number]): ScheduledSurfaceCell {
  return {
    id: cell.id,
    center: cell.center,
    representativePoint: deriveInteriorRepresentativePoint(cell.geometry, cell.center),
    geometry: cell.geometry,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
