import "server-only";

import { freezeEnvelope } from "./freeze.ts";
import { ProviderNotConfiguredError, ProviderUnavailableError, type ScheduledAccessSeedProvider, type ScheduledAccessSeedCandidate } from "../providers.ts";
import {
  buildScheduledStationAreaCatalog,
  createParticipantSurface,
  evaluateScheduledStationAreaCandidates,
} from "./surface.ts";
import {
  DEFAULT_TRANSFER_RADIUS_METERS,
  DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND,
  createScheduledRoutingWindow,
  routeScheduledEarliestArrivals,
} from "./router.ts";
import {
  CHANGE_TIME_PRESETS,
  WALKING_SECONDS_ROUNDING_RULE,
  type ScheduledAccessSeed,
  type ScheduledRoutingArtifact,
  type ScheduledDeadlineCheck,
  type ScheduledParticipantSurface,
  type ScheduledStationAreaCatalog,
  type ItineraryEdge,
} from "./models.ts";
import type { ScheduledMeetingRequest, ScheduledMeetingParticipantInput } from "../../validation/meeting-v3.ts";
import type {
  ScheduledMeetingStationAreaDto,
  ScheduledMeetingParticipantDto,
  ScheduledMeetingResponseDto,
} from "../../validation/meeting-v3.ts";
import type {
  CalculationProgressPhase as MeetingCalculationPhase,
  StationVerdict,
} from "../calculation-progress-contract.ts";

export type { MeetingCalculationPhase, StationVerdict };

/**
 * Finer-grained pipeline stages inside a single calculation. The coarse
 * `onPhase` contract is unchanged; `onStage` is an optional additive
 * instrumentation seam used by the profiling harness (issue #72) and is not
 * part of the client progress contract.
 */
export type ScheduledCalculationStage =
  | "access-seeds"
  | "station-area-catalog"
  | "routing-window"
  | "scan-red"
  | "scan-blue"
  | "participant-surfaces"
  | "station-area-evaluation"
  | "response-build";

export interface ScheduledMeetingCalculationHooks {
  readonly onPhase?: (phase: MeetingCalculationPhase) => void | Promise<void>;
  readonly onStationVerdict?: (verdict: StationVerdict) => void | Promise<void>;
  /** Called immediately before each pipeline stage starts. */
  readonly onStage?: (stage: ScheduledCalculationStage) => void | Promise<void>;
}

export interface ScheduledMeetingProviderBundle {
  readonly artifact?: ScheduledRoutingArtifact;
  readonly access?: ScheduledAccessSeedProvider;
  readonly walkingVelocityMetersPerSecond?: number;
  readonly transferRadiusMeters?: number;
  readonly deadlineCheck?: ScheduledDeadlineCheck;
}

export type ScheduledParticipantResponse = ScheduledMeetingParticipantDto;
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
    readonly changeTimeSeconds: number;
    readonly walkingVelocityMetersPerSecond: number;
    readonly walkingSecondsRoundingRule: string;
    readonly transferRadiusMeters: number;
  };
  readonly scheduleProvenance: ScheduledMeetingResponseDto["metadata"]["schedule"];
  readonly accessProvenance: ScheduledMeetingResponseDto["metadata"]["accessProvider"];
  readonly status: ScheduledMeetingResponseDto["status"];
  readonly reason: ScheduledMeetingResponseDto["reason"];
  readonly stationAreas: readonly ScheduledMeetingStationAreaDto[];
  /**
   * Certified per-participant arrival graph (predecessor edges keyed by
   * station-area id), produced by the same scan that set the marker arrivals.
   * Consumed at details time to rebuild itinerary legs without re-running
   * routing. Index 0 = red participant, index 1 = blue participant.
   */
  readonly itineraryGraph: readonly [Readonly<Record<string, ItineraryEdge>>, Readonly<Record<string, ItineraryEdge>>];
}

export interface ScheduledMeetingCalculation {
  readonly response: ScheduledMeetingResponse;
  readonly basis: ScheduledCalculationBasis;
  readonly stationAreaCatalog: ScheduledStationAreaCatalog;
}

export async function calculateScheduledMeeting(
  request: ScheduledMeetingRequest,
  providers: ScheduledMeetingProviderBundle,
  signal?: AbortSignal,
  hooks?: ScheduledMeetingCalculationHooks,
): Promise<ScheduledMeetingResponse> {
  const calculation = await calculateScheduledMeetingWithBasis(request, providers, signal, hooks);
  return calculation.response;
}

export async function calculateScheduledMeetingWithBasis(
  request: ScheduledMeetingRequest,
  providers: ScheduledMeetingProviderBundle,
  signal?: AbortSignal,
  hooks?: ScheduledMeetingCalculationHooks,
): Promise<ScheduledMeetingCalculation> {
  providers.deadlineCheck?.("meeting-start");
  const artifact = providers.artifact;
  if (artifact === undefined) throw new ProviderNotConfiguredError("routing");
  const access = providers.access;
  if (access === undefined) throw new ProviderNotConfiguredError("routing");
  if (signal?.aborted) throw new ProviderUnavailableError("routing");
  const changeTimeSeconds = CHANGE_TIME_PRESETS[request.changeTimePreset];
  const walkingVelocityMetersPerSecond = providers.walkingVelocityMetersPerSecond ?? DEFAULT_WALKING_VELOCITY_METERS_PER_SECOND;
  const transferRadiusMeters = providers.transferRadiusMeters ?? DEFAULT_TRANSFER_RADIUS_METERS;
  let seedSets: [readonly ScheduledAccessSeedCandidate[], readonly ScheduledAccessSeedCandidate[]];
  try {
    await hooks?.onPhase?.("access-seeds");
    await hooks?.onStage?.("access-seeds");
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
  await hooks?.onPhase?.("scheduled-routing");
  await hooks?.onStage?.("station-area-catalog");
  const stationAreaCatalog = buildScheduledStationAreaCatalog(artifact, providers.deadlineCheck);
  await hooks?.onStage?.("routing-window");
  const window = createScheduledRoutingWindow(artifact, request.searchStartAt, {
    walkingVelocityMetersPerSecond,
    transferRadiusMeters,
    changeTimeSeconds,
    deadlineCheck: providers.deadlineCheck,
  });
  await hooks?.onStage?.("scan-red");
  const firstRoute = scheduledSeedSets[0].length === 0
    ? null
    : routeScheduledEarliestArrivals(artifact, scheduledSeedSets[0], request.searchStartAt, { deadlineCheck: providers.deadlineCheck }, window);
  await hooks?.onStage?.("scan-blue");
  const secondRoute = scheduledSeedSets[1].length === 0
    ? null
    : routeScheduledEarliestArrivals(artifact, scheduledSeedSets[1], request.searchStartAt, { deadlineCheck: providers.deadlineCheck }, window);
  await hooks?.onStage?.("participant-surfaces");
  const participantSurfaces: [ScheduledParticipantSurface, ScheduledParticipantSurface] = [
    createParticipantSurface(request.participants[0].id, artifact, firstRoute),
    createParticipantSurface(request.participants[1].id, artifact, secondRoute),
  ];
  const firstReachable = firstRoute?.reachableStationAreaCount ?? 0;
  const secondReachable = secondRoute?.reachableStationAreaCount ?? 0;
  const noAccessSeeds = scheduledSeedSets[0].length === 0 || scheduledSeedSets[1].length === 0;
  const noResult = noAccessSeeds || firstReachable === 0 || secondReachable === 0;
  providers.deadlineCheck?.("meeting-surface");

  await hooks?.onPhase?.("station-area-evaluation");
  await hooks?.onStage?.("station-area-evaluation");
  const stationAreas: ScheduledMeetingStationAreaDto[] = [];
  await evaluateScheduledStationAreaCandidates(
    stationAreaCatalog,
    participantSurfaces[0].stationArrivals,
    participantSurfaces[1].stationArrivals,
    noResult,
    request.tolerancePercent,
    providers.deadlineCheck,
    (candidate) => {
      const area: ScheduledMeetingStationAreaDto = {
        stationAreaId: candidate.stationAreaId,
        name: candidate.name,
        coordinate: candidate.coordinate,
        mode: candidate.mode,
        classification: candidate.classification,
        redArrivalSeconds: candidate.redArrivalSeconds,
        blueArrivalSeconds: candidate.blueArrivalSeconds,
        fasterParticipant: candidate.fasterParticipant,
        withinSelectedTolerance: candidate.withinSelectedTolerance,
      };
      stationAreas.push(area);
      return hooks?.onStationVerdict?.({
        stationAreaId: candidate.stationAreaId,
        name: candidate.name,
        coordinate: candidate.coordinate,
        mode: candidate.mode,
        verdict: candidate.classification,
      });
    },
  );
  providers.deadlineCheck?.("meeting-result");
  await hooks?.onStage?.("response-build");
  const response: ScheduledMeetingResponse = {
    contractVersion: "meeet-meeting/v3",
    status: noResult ? "no-result" : "ok",
    reason: noAccessSeeds ? "no-access-seeds" : firstReachable === 0 || secondReachable === 0 ? "no-reachable-stations" : null,
    participants: [
      participantResponse(request.participants[0], "red", seedSets[0]),
      participantResponse(request.participants[1], "blue", seedSets[1]),
    ],
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
        contractVersion: "meeet-scheduled-routing/v1",
        scheduleContentHash: artifact.provenance.contentHash,
        compiledArtifactId: artifact.provenance.compiledArtifactId,
        feedId: artifact.feedId,
        timeZone: artifact.timeZone,
        searchStartAt: window.searchStartAt,
        routingHorizonSeconds: 86400,
        selectedTolerancePercent: request.tolerancePercent,
        changeTimeSeconds,
        walkingVelocityMetersPerSecond,
        walkingSecondsRoundingRule: WALKING_SECONDS_ROUNDING_RULE,
        transferRadiusMeters,
        accessSeedCounts: [scheduledSeedSets[0].length, scheduledSeedSets[1].length],
        stationAreaCount: artifact.stationAreas.length,
        connectionCount: artifact.connections.length,
        coverage: "scheduled-service-day-local-radius/v1",
        representativePointBasis: "station-area-coordinate/v1",
        classificationMethod: "scheduled-arrival-comparison-with-selected-tolerance/v1",
        classificationBasis: "scheduled-station-area-arrival/v1",
        finalWalkingMethod: "scheduled-access-and-transfer-walking/v1",
      },
      stationAreas: {
        count: stationAreas.length,
        coverage: "official-munich-boundary-with-connected-artifact-station-areas/v1",
        selection: "all-eligible-scheduled-station-areas/v1",
      },
      accessProvider: access.descriptor,
      coverage: "munich-scheduled-station-area-meeting/v1",
      origins: { coverage: "globally-valid-origin/v1" },
    },
  };
  freezeEnvelope(response);
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
      routingHorizonSeconds: response.metadata.surface.routingHorizonSeconds,
      changeTimeSeconds: response.metadata.surface.changeTimeSeconds,
      walkingVelocityMetersPerSecond: response.metadata.surface.walkingVelocityMetersPerSecond,
      walkingSecondsRoundingRule: response.metadata.surface.walkingSecondsRoundingRule,
      transferRadiusMeters: response.metadata.surface.transferRadiusMeters,
    },
    scheduleProvenance: response.metadata.schedule,
    accessProvenance: response.metadata.accessProvider,
    status: response.status,
    reason: response.reason,
    stationAreas: response.stationAreas.map((stationArea) => ({ ...stationArea })),
    itineraryGraph: [firstRoute?.predecessorByArea ?? {}, secondRoute?.predecessorByArea ?? {}],
  };
  const calculation: ScheduledMeetingCalculation = { response, basis, stationAreaCatalog };
  freezeEnvelope(calculation);
  return calculation;
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
    accessSeconds: candidate.accessSeconds,
  };
}

function cloneScheduledAccessSeed(seed: ScheduledAccessSeed): ScheduledAccessSeed {
  return {
    stationAreaId: seed.stationAreaId,
    accessSeconds: seed.accessSeconds,
  };
}

function cloneAccessSeedCandidate(candidate: ScheduledAccessSeedCandidate): ScheduledAccessSeedCandidate {
  return {
    seedId: candidate.seedId,
    mvgStationId: candidate.mvgStationId,
    stationAreaId: candidate.stationAreaId,
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
    changeTimePreset: request.changeTimePreset,
    searchStartAt: request.searchStartAt,
  };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
