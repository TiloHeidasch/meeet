import "server-only";

import { haversineDistanceKm } from "./geo.ts";
import {
  isWithinOfficialMunichBoundary,
  OFFICIAL_MUNICH_BOUNDARY_MANIFEST,
} from "./boundary.ts";
import type { CoordinateJourneyProvider, MeetingProviders } from "./providers.ts";
import type {
  CoordinateJourney,
  CoordinateJourneyPart,
  CoordinateJourneyRequest,
  FairLocation,
  JourneyEndpoint,
  LocationCoordinate,
  MeetingCalculationInput,
  MeetingCalculationMetadata,
  MeetingCalculationNoResultResponse,
  MeetingCalculationOkResponse,
  MeetingCalculationResponse,
  MeetingParticipant,
  MeetingPatternSearchCoverage,
  MeetingSearchCoverage,
  MeetingSearchCoverageTermination,
  MeetingSearchDirection,
  MeetingSourceQueryProvenance,
  OfficialBoundaryMetadata,
  PlannedParticipantJourney,
  ProviderDescriptor,
  RoutePattern,
  RoutePatternProvenance,
  RoutePatternSearchKind,
  TolerancePercent,
  TransitLineReference,
} from "./types.ts";
import { MEETING_SEARCH_COVERAGE_METHOD, MEETING_TIME_ZONE } from "./types.ts";
import { compareFairLocationOrder, fairLocationOrderKey } from "./fair-location-order.ts";

export const MVG_ANCHOR_STATIONS = [
  { id: "de:09162:6", label: "Hauptbahnhof" },
  { id: "de:09162:50", label: "Sendlinger Tor" },
  { id: "de:09162:70", label: "Universität" },
  { id: "de:09162:1170", label: "Silberhornstraße" },
  { id: "de:09162:190", label: "Rotkreuzplatz" },
  { id: "de:09162:350", label: "Olympiazentrum" },
] as const;

const MAX_LOCATION_LABEL_LENGTH = 512;
const MAX_PLANNED_JOURNEY_DURATION_MS = 24 * 60 * 60 * 1_000;
/** Full sampled-search runtime budget; this is not a short approximation or truncation deadline. */
export const MEETING_CALCULATION_DEADLINE_MS = 90_000;
/** Two pattern searches × two participant checks bounds normal verification concurrency at four calls. */
export const MAX_PATTERN_SEARCH_CONCURRENCY = 2;
export const MAX_CANDIDATE_VERIFICATION_REQUESTS = 1_000;
export const COORDINATE_BINDING_TOLERANCE_METRES = 1;

export interface MeetingCalculationOptions {
  /** Test/deployment override; production uses the documented 90-second full-search bound. */
  deadlineMs?: number;
  /** Exceeding this budget fails; work is never truncated. */
  maxCandidateVerificationRequests?: number;
}

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
  readonly issues: readonly { path: Array<string | number>; code: string; message: string }[];

  constructor(
    message: string,
    issues: readonly { path: Array<string | number>; code: string; message: string }[],
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

/** Retained for callers of the old domain seam; no-result is now a response. */
export class NoFairLocationError extends Error {
  constructor() {
    super("MVG returned no qualifying Route-Derived Fair Location through the maximum tolerance.");
    this.name = "NoFairLocationError";
  }
}

interface PatternBuild {
  pattern: RoutePattern;
  representativeJourney: CoordinateJourney;
}

interface SourceRequest extends CoordinateJourneyRequest {
  direction: MeetingSearchDirection;
  searchKind: RoutePatternSearchKind;
  anchorStationGlobalId: string | null;
  originParticipantId: string;
  destinationParticipantId: string;
}

interface TargetOccurrence {
  transitStopIndex: number;
  endpoint: JourneyEndpoint;
}

interface VerifiedOccurrence {
  patternId: string;
  transitStopIndex: number;
  endpoint: JourneyEndpoint;
  journeys: readonly [PlannedParticipantJourney, PlannedParticipantJourney];
  differenceMilliseconds: number;
}

interface PatternSearchResult {
  pattern: RoutePattern;
  eligible: readonly TargetOccurrence[];
  evaluated: readonly VerifiedOccurrence[];
  discovered: readonly VerifiedOccurrence[];
  coverage: MeetingPatternSearchCoverage;
}

/**
 * Calculate the Route-Guided Fair Location Search result. Source discovery is finite,
 * while target verification is a directional local search rather than an
 * exhaustive claim.
 */
export async function calculateMeeting(
  input: MeetingCalculationInput,
  providers: MeetingProviders,
  signal?: AbortSignal,
  options: MeetingCalculationOptions = {},
): Promise<MeetingCalculationResponse> {
  if (signal?.aborted) throw new ProviderUnavailableError("routing");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const deadlineMs = options.deadlineMs ?? MEETING_CALCULATION_DEADLINE_MS;
  const timer = setTimeout(abort, deadlineMs);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new ProviderUnavailableError("routing")), deadlineMs);
  });
  const callerAborted = signal
    ? new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ProviderUnavailableError("routing")), { once: true }))
    : null;
  try {
    return await Promise.race([
      calculateMeetingCore(input, providers, controller.signal, options),
      timeout,
      ...(callerAborted ? [callerAborted] : []),
    ]);
  } finally {
    clearTimeout(timer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

async function calculateMeetingCore(
  input: MeetingCalculationInput,
  providers: MeetingProviders,
  signal: AbortSignal,
  options: MeetingCalculationOptions,
): Promise<MeetingCalculationResponse> {
  validateCanonicalInput(input);
  const journeyProvider = resolveJourneyProvider(providers);
  const participants = input.participants;
  const arrivalAt = input.arrivalAt;

  participants.forEach((participant) => {
    if (!isWithinOfficialMunichBoundary(participant.location)) {
      throw new ResolvedLocationOutsideMunichError();
    }
  });

  const sourceRequests = createSourceRequests(arrivalAt, participants, signal);
  const sourceResults = await Promise.all(
    sourceRequests.map((request) => invokeJourneyProvider(journeyProvider, toProviderRequest(request))),
  );

  const patternMap = new Map<string, PatternBuild>();
  sourceResults.forEach((result, sourceIndex) => {
    const source = sourceRequests[sourceIndex]!;
    result.journeys.forEach((rawJourney) => {
      const journey = normalizeJourneyCoordinates(rawJourney);
      validateJourney(journey, arrivalAt);
      upsertRoutePattern(
        patternMap,
        journey,
        source.direction,
        source.searchKind,
        source.anchorStationGlobalId,
      );
    });
  });

  const maxVerificationRequests = options.maxCandidateVerificationRequests ?? MAX_CANDIDATE_VERIFICATION_REQUESTS;
  const verificationCache = new Map<string, Promise<{ journeys: readonly CoordinateJourney[]; source: string }>>();
  let issuedVerificationRequests = 0;

  const getVerificationResult = (
    participantIndex: 0 | 1,
    coordinate: LocationCoordinate,
  ): Promise<{ journeys: readonly CoordinateJourney[]; source: string }> => {
    const key = verificationKey(participants[participantIndex].id, coordinate);
    const existing = verificationCache.get(key);
    if (existing) return existing;
    if (issuedVerificationRequests >= maxVerificationRequests) {
      throw new ProviderUnavailableError("routing");
    }
    issuedVerificationRequests += 1;
    const promise = invokeJourneyProvider(journeyProvider, {
      origin: coordinateOnly(participants[participantIndex].location),
      destination: coordinateOnly(coordinate),
      arrivalAt,
      signal,
    }).catch((error: unknown) => {
      verificationCache.delete(key);
      throw error;
    });
    verificationCache.set(key, promise);
    return promise;
  };

  const verifyOccurrence = async (
    pattern: RoutePattern,
    occurrence: TargetOccurrence,
  ): Promise<VerifiedOccurrence> => {
    const keys = participants.map((participant) => verificationKey(participant.id, occurrence.endpoint.coordinate));
    const missing = keys.filter((key) => !verificationCache.has(key)).length;
    if (issuedVerificationRequests + missing > maxVerificationRequests) {
      throw new ProviderUnavailableError("routing");
    }
    const results = await Promise.all([
      getVerificationResult(0, occurrence.endpoint.coordinate),
      getVerificationResult(1, occurrence.endpoint.coordinate),
    ]);
    const selected = results.map((result) => selectJourney(result.journeys, arrivalAt)) as [CoordinateJourney, CoordinateJourney];
    const journeys: [PlannedParticipantJourney, PlannedParticipantJourney] = [
      toParticipantJourney(participants[0], selected[0], occurrence.endpoint, results[0].source || journeyProvider.descriptor.name),
      toParticipantJourney(participants[1], selected[1], occurrence.endpoint, results[1].source || journeyProvider.descriptor.name),
    ];
    return {
      patternId: pattern.id,
      transitStopIndex: occurrence.transitStopIndex,
      endpoint: occurrence.endpoint,
      journeys,
      differenceMilliseconds: Math.abs(journeys[0].plannedDurationMilliseconds - journeys[1].plannedDurationMilliseconds),
    };
  };

  const patternBuilds = [...patternMap.values()];
  const searches: Array<PatternSearchResult | undefined> = new Array(patternBuilds.length);
  let nextPatternIndex = 0;
  const searchWorker = async (): Promise<void> => {
    while (true) {
      const patternIndex = nextPatternIndex;
      nextPatternIndex += 1;
      if (patternIndex >= patternBuilds.length) return;
      const pattern = patternBuilds[patternIndex]!.pattern;
      const eligible = eligibleStationOccurrences(pattern);
      if (eligible.length === 0) {
        searches[patternIndex] = {
          pattern,
          eligible,
          evaluated: [],
          discovered: [],
          coverage: patternCoverage(pattern, eligible, [], [], "no-transit-station-targets"),
        };
        continue;
      }
      searches[patternIndex] = await searchPattern(pattern, eligible, verifyOccurrence);
    }
  };
  const workerCount = Math.min(MAX_PATTERN_SEARCH_CONCURRENCY, patternBuilds.length);
  await Promise.all(Array.from({ length: workerCount }, () => searchWorker()));
  const orderedSearches = searches as PatternSearchResult[];

  const searchCoverage = createSearchCoverage(orderedSearches);
  const sourceQueries = sourceResults.map((result, index) => toSourceQueryProvenance(sourceRequests[index]!, result));
  const metadata = createMetadata(journeyProvider.descriptor);
  const effectiveBase: MeetingCalculationInput["tolerancePercent"] = input.tolerancePercent;
  const common = {
    contractVersion: "meeet-meeting/v2" as const,
    requestSnapshot: {
      participants,
      arrivalAt,
      selectedTolerancePercent: input.tolerancePercent,
      effectiveTolerancePercent: effectiveBase,
      timeZone: MEETING_TIME_ZONE,
    },
    routePatterns: [...patternMap.values()].map((entry) => entry.pattern),
    sourceQueries,
    metadata,
    searchCoverage,
  };

  const allDiscovered = orderedSearches.flatMap((search) => search.discovered);
  if (allDiscovered.length === 0 && orderedSearches.every((search) => search.eligible.length === 0)) {
    const response: MeetingCalculationNoResultResponse = {
      ...common,
      status: "no-result",
      reason: "no-transit-station-targets",
      fairLocations: [],
    };
    return response;
  }

  let qualifying: VerifiedOccurrence[] = [];
  let effectiveTolerancePercent = input.tolerancePercent;
  for (let tolerance = input.tolerancePercent; tolerance <= 100; tolerance += 5) {
    const current = allDiscovered.filter((candidate) => isFairPair(
      candidate.journeys[0].plannedDurationMilliseconds,
      candidate.journeys[1].plannedDurationMilliseconds,
      tolerance,
    ));
    if (current.length > 0) {
      qualifying = current;
      effectiveTolerancePercent = tolerance;
      break;
    }
  }

  // Positive integer durations always qualify at 100%; this branch is kept
  // defensive so an impossible malformed internal result never becomes DTO.
  if (qualifying.length === 0) throw new ProviderUnavailableError("routing");

  const fairLocations = mergeQualifiedOccurrences(qualifying, input.tolerancePercent, effectiveTolerancePercent);
  const response: MeetingCalculationOkResponse = {
    ...common,
    status: "ok",
    requestSnapshot: {
      ...common.requestSnapshot,
      effectiveTolerancePercent,
    },
    fairLocations,
  };
  return response;
}

function validateCanonicalInput(input: MeetingCalculationInput): void {
  if (
    input.participants.length !== 2 ||
    input.participants.some((participant) => participant.mode !== "transit") ||
    !Number.isFinite(Date.parse(input.arrivalAt))
  ) {
    throw new InvalidRoutingRequestError(
      "The canonical meeting search requires exactly two transit participants and a valid arrivalAt.",
      [{ path: ["participants"], code: "canonical_request_invalid", message: "Exactly two transit participants and arrivalAt are required." }],
    );
  }
}

function resolveJourneyProvider(providers: MeetingProviders): CoordinateJourneyProvider {
  if (providers.journey) return providers.journey;
  throw new ProviderNotConfiguredError("routing");
}

function createSourceRequests(
  arrivalAt: string,
  participants: readonly [MeetingParticipant, MeetingParticipant],
  signal?: AbortSignal,
): SourceRequest[] {
  const requests: SourceRequest[] = [];
  const directions: Array<readonly [MeetingParticipant, MeetingParticipant, MeetingSearchDirection]> = [
    [participants[0], participants[1], "participant-1-to-participant-2"],
    [participants[1], participants[0], "participant-2-to-participant-1"],
  ];
  for (const [origin, destination, direction] of directions) {
    requests.push({
      origin: origin.location,
      destination: destination.location,
      arrivalAt,
      signal,
      direction,
      searchKind: "direct",
      anchorStationGlobalId: null,
      originParticipantId: origin.id,
      destinationParticipantId: destination.id,
    });
    for (const anchor of MVG_ANCHOR_STATIONS) {
      requests.push({
        origin: origin.location,
        destination: destination.location,
        arrivalAt,
        viaStationGlobalId: anchor.id,
        viaDwellTimeInMinutes: 10,
        signal,
        direction,
        searchKind: "anchor",
        anchorStationGlobalId: anchor.id,
        originParticipantId: origin.id,
        destinationParticipantId: destination.id,
      });
    }
  }
  return requests;
}

function toProviderRequest(request: SourceRequest): CoordinateJourneyRequest {
  return {
    origin: request.origin,
    destination: request.destination,
    arrivalAt: request.arrivalAt,
    ...(request.viaStationGlobalId === undefined ? {} : { viaStationGlobalId: request.viaStationGlobalId }),
    ...(request.viaDwellTimeInMinutes === undefined ? {} : { viaDwellTimeInMinutes: request.viaDwellTimeInMinutes }),
    signal: request.signal,
  };
}

function toSourceQueryProvenance(
  request: SourceRequest,
  result: { journeys: readonly CoordinateJourney[]; source: string },
): MeetingSourceQueryProvenance {
  return {
    direction: request.direction,
    searchKind: request.searchKind,
    originParticipantId: request.originParticipantId,
    destinationParticipantId: request.destinationParticipantId,
    anchorStationGlobalId: request.anchorStationGlobalId,
    viaDwellTimeInMinutes: request.viaStationGlobalId ? 10 : null,
    arrivalAt: request.arrivalAt,
    journeyCount: result.journeys.length,
    source: result.source,
  };
}

async function invokeJourneyProvider(
  provider: CoordinateJourneyProvider,
  request: CoordinateJourneyRequest,
): Promise<{ journeys: readonly CoordinateJourney[]; source: string }> {
  try {
    const result = await provider.getCoordinateJourneys(request);
    if (!result || !Array.isArray(result.journeys) || typeof result.source !== "string" || !result.source.trim()) {
      throw new Error("The journey provider returned an incomplete result.");
    }
    for (const journey of result.journeys) {
      validateJourney(journey, request.arrivalAt);
      if (!coordinatesWithinMvgPrecision(journey.parts[0]!.from.coordinate, request.origin) || !coordinatesWithinMvgPrecision(journey.parts.at(-1)!.to.coordinate, request.destination)) {
        throw new Error("The journey is not bound to its requested origin and destination.");
      }
      if (request.viaStationGlobalId && !journey.parts.some((part: CoordinateJourneyPart) => part.kind === "transit" && (
        part.from.stationGlobalId === request.viaStationGlobalId ||
        part.to.stationGlobalId === request.viaStationGlobalId ||
        part.intermediateStops.some((stop) => stop.stationGlobalId === request.viaStationGlobalId)
      ))) {
        throw new Error("The via journey did not traverse its requested anchor station.");
      }
    }
    return result;
  } catch (error) {
    if (error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError) throw error;
    throw new ProviderUnavailableError("routing");
  }
}

function validateJourney(journey: CoordinateJourney, arrivalAt: string): void {
  if (!journey || !Array.isArray(journey.transitStops) || !Array.isArray(journey.parts) || journey.parts.length === 0 || journey.parts.length > 100) {
    throw new ProviderUnavailableError("routing");
  }
  journey.transitStops.forEach((stop) => {
    if (!stop || typeof stop.stationGlobalId !== "string" || !stop.stationGlobalId || !isValidCoordinate(stop.coordinate)) {
      throw new ProviderUnavailableError("routing");
    }
  });
  const departure = Date.parse(journey.plannedDepartureAt);
  const arrival = Date.parse(journey.plannedArrivalAt);
  if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival < departure || arrival > Date.parse(arrivalAt) || arrival - departure > MAX_PLANNED_JOURNEY_DURATION_MS || !Number.isInteger(journey.plannedDurationMilliseconds) || journey.plannedDurationMilliseconds !== arrival - departure) {
    throw new ProviderUnavailableError("routing");
  }
  journey.parts.forEach((part, index) => {
    if (!part || (part.kind !== "transit" && part.kind !== "walking") || !part.from || !part.to || (part.from.stationGlobalId !== null && typeof part.from.stationGlobalId !== "string") || (part.to.stationGlobalId !== null && typeof part.to.stationGlobalId !== "string") || !isValidCoordinate(part.from.coordinate) || !isValidCoordinate(part.to.coordinate) || !isCanonicalInstant(part.plannedDepartureAt) || !isCanonicalInstant(part.plannedArrivalAt) || Date.parse(part.plannedArrivalAt) < Date.parse(part.plannedDepartureAt)) {
      throw new ProviderUnavailableError("routing");
    }
    if (index > 0) {
      const previous = journey.parts[index - 1]!;
      const sameStation = previous.to.stationGlobalId !== null && part.from.stationGlobalId !== null && previous.to.stationGlobalId === part.from.stationGlobalId;
      const sameCoordinate = coordinatesWithinMvgPrecision(previous.to.coordinate, part.from.coordinate);
      if (!sameStation && !sameCoordinate) throw new ProviderUnavailableError("routing");
      if (Date.parse(part.plannedDepartureAt) < Date.parse(previous.plannedArrivalAt)) throw new ProviderUnavailableError("routing");
    }
    if (part.kind === "transit" && (!part.line || typeof part.line.identity !== "string" || typeof part.line.type !== "string" || !part.from.stationGlobalId || !part.to.stationGlobalId)) {
      throw new ProviderUnavailableError("routing");
    }
    if (!Array.isArray(part.intermediateStops) || part.intermediateStops.some((stop: JourneyEndpoint) => !stop || typeof stop.stationGlobalId !== "string" || !stop.stationGlobalId || !isValidCoordinate(stop.coordinate))) {
      throw new ProviderUnavailableError("routing");
    }
    if (part.kind === "walking" && part.line !== null) throw new ProviderUnavailableError("routing");
  });
  if (journey.parts[0]!.plannedDepartureAt !== journey.plannedDepartureAt || journey.parts.at(-1)!.plannedArrivalAt !== journey.plannedArrivalAt) throw new ProviderUnavailableError("routing");
}

function upsertRoutePattern(
  patterns: Map<string, PatternBuild>,
  journey: CoordinateJourney,
  direction: MeetingSearchDirection,
  searchKind: RoutePatternSearchKind,
  anchorStationGlobalId: string | null,
): RoutePattern {
  const shape = structuralShape(journey, direction);
  const provenance: RoutePatternProvenance = { direction, searchKind, anchorStationGlobalId };
  const existing = patterns.get(shape.key);
  if (existing) {
    const provenanceAlreadyPresent = existing.pattern.provenance.some((item) => provenanceKey(item) === provenanceKey(provenance));
    const representative = compareRepresentativeJourney(journey, existing.representativeJourney) < 0 ? journey : existing.representativeJourney;
    const pattern = {
      ...existing.pattern,
      ...(representative === existing.representativeJourney ? {} : {
        transitStops: structuralShape(representative, direction).transitStops,
        lines: structuralShape(representative, direction).lines,
        parts: representative.parts,
      }),
      provenance: provenanceAlreadyPresent ? existing.pattern.provenance : [...existing.pattern.provenance, provenance],
    };
    patterns.set(shape.key, { pattern, representativeJourney: representative });
    return pattern;
  }
  const pattern: RoutePattern = {
    id: `route-pattern:${stableHash(shape.key)}`,
    kind: shape.kind,
    transitStops: shape.transitStops,
    lines: shape.lines,
    parts: journey.parts,
    provenance: [provenance],
  };
  patterns.set(shape.key, { pattern, representativeJourney: journey });
  return pattern;
}

function structuralShape(journey: CoordinateJourney, direction: MeetingSearchDirection): {
  key: string;
  kind: "transit" | "walk-only";
  transitStops: readonly JourneyEndpoint[];
  lines: readonly TransitLineReference[];
} {
  const transitParts = journey.parts.filter((part) => part.kind === "transit");
  if (transitParts.length === 0) {
    const endpoints = journey.parts.flatMap((part) => [part.from, part.to]);
    const key = `walk-only:${JSON.stringify({ direction, endpoints: endpoints.map(endpointIdentity) })}`;
    return { key, kind: "walk-only", transitStops: [], lines: [] };
  }
  const stops: JourneyEndpoint[] = [];
  const lines: TransitLineReference[] = [];
  for (const part of transitParts) {
    stops.push(part.from, ...part.intermediateStops, part.to);
    if (part.line) lines.push(part.line);
  }
  const key = `transit:${JSON.stringify({ direction, stops: stops.map((stop) => stop.stationGlobalId), lines: lines.map((line) => [line.identity, line.type]) })}`;
  return { key, kind: "transit", transitStops: stops, lines };
}

function eligibleStationOccurrences(
  pattern: RoutePattern,
): TargetOccurrence[] {
  const occurrences: TargetOccurrence[] = [];
  let index = 0;
  while (index < pattern.transitStops.length) {
    const endpoint = pattern.transitStops[index]!;
    const stationId = endpoint.stationGlobalId;
    let end = index + 1;
    while (end < pattern.transitStops.length && pattern.transitStops[end]!.stationGlobalId === stationId) end += 1;
    if (typeof stationId === "string") {
      for (let candidateIndex = index; candidateIndex < end; candidateIndex += 1) {
        const candidate = pattern.transitStops[candidateIndex]!;
        if (isWithinOfficialMunichBoundary(candidate.coordinate)) {
          occurrences.push({ transitStopIndex: candidateIndex, endpoint: candidate });
          break;
        }
      }
    }
    index = end;
  }
  return occurrences;
}

async function searchPattern(
  pattern: RoutePattern,
  eligible: readonly TargetOccurrence[],
  verify: (pattern: RoutePattern, occurrence: TargetOccurrence) => Promise<VerifiedOccurrence>,
): Promise<PatternSearchResult> {
  const evaluated = new Map<number, VerifiedOccurrence>();
  const evaluate = async (ordinal: number): Promise<VerifiedOccurrence> => {
    const occurrence = eligible[ordinal]!;
    const existing = evaluated.get(occurrence.transitStopIndex);
    if (existing) return existing;
    const value = await verify(pattern, occurrence);
    evaluated.set(occurrence.transitStopIndex, value);
    return value;
  };
  const startOrdinal = Math.floor((eligible.length - 1) / 2);
  let currentOrdinal = startOrdinal;
  let current = await evaluate(currentOrdinal);
  const sourceParticipantIndex = pattern.provenance[0]?.direction === "participant-2-to-participant-1" ? 1 : 0;
  const direction = current.journeys[sourceParticipantIndex].plannedDurationMilliseconds <= current.journeys[1 - sourceParticipantIndex].plannedDurationMilliseconds ? 1 : -1;
  const scanBoundary = async (
    ordinal: number,
    scanDirection: 1 | -1,
    difference: number,
  ): Promise<{ equal: VerifiedOccurrence[]; boundary: VerifiedOccurrence | null }> => {
    const equal: VerifiedOccurrence[] = [];
    let nextOrdinal = ordinal + scanDirection;
    while (nextOrdinal >= 0 && nextOrdinal < eligible.length) {
      const next = await evaluate(nextOrdinal);
      if (next.differenceMilliseconds === difference) {
        equal.push(next);
        nextOrdinal += scanDirection;
        continue;
      }
      return { equal, boundary: next };
    }
    return { equal, boundary: null };
  };

  while (true) {
    const difference = current.differenceMilliseconds;
    const preferred = await scanBoundary(currentOrdinal, direction, difference);
    if (preferred.boundary && preferred.boundary.differenceMilliseconds < difference) {
      currentOrdinal = eligible.findIndex((occurrence) => occurrence.transitStopIndex === preferred.boundary!.transitStopIndex);
      current = preferred.boundary;
      continue;
    }

    // A rising preferred boundary, a preferred boundary, or an equal
    // plateau must also be checked on the opposite side. Equal occurrences
    // are collected on both sides, but only a strictly lower boundary moves
    // the search.
    const opposite = await scanBoundary(currentOrdinal, direction === 1 ? -1 : 1, difference);
    if (opposite.boundary && opposite.boundary.differenceMilliseconds < difference) {
      currentOrdinal = eligible.findIndex((occurrence) => occurrence.transitStopIndex === opposite.boundary!.transitStopIndex);
      current = opposite.boundary;
      continue;
    }

    const plateau = [current, ...preferred.equal, ...opposite.equal]
      .sort((left, right) => left.transitStopIndex - right.transitStopIndex);
    {
      const discovered = plateau;
      const evaluatedValues = [...evaluated.values()];
      return {
        pattern,
        eligible,
        evaluated: evaluatedValues,
        discovered,
        coverage: patternCoverage(pattern, eligible, evaluatedValues, discovered, "local-minima-discovered"),
      };
    }
  }
}

function patternCoverage(
  pattern: RoutePattern,
  eligible: readonly TargetOccurrence[],
  evaluated: readonly VerifiedOccurrence[],
  discovered: readonly VerifiedOccurrence[],
  termination: MeetingSearchCoverageTermination,
): MeetingPatternSearchCoverage {
  return {
    routePatternId: pattern.id,
    eligibleStationOccurrenceCount: eligible.length,
    startTransitStopIndex: eligible.length === 0 ? null : eligible[Math.floor((eligible.length - 1) / 2)]!.transitStopIndex,
    evaluatedTransitStopIndexes: evaluated.map((entry) => entry.transitStopIndex),
    discoveredLocalMinimumTransitStopIndexes: discovered.map((entry) => entry.transitStopIndex),
    termination,
  };
}

function createSearchCoverage(searches: readonly PatternSearchResult[]): MeetingSearchCoverage {
  const patterns = searches.map((search) => search.coverage);
  const evaluatedStationOccurrenceCount = patterns.reduce((sum, pattern) => sum + pattern.evaluatedTransitStopIndexes.length, 0);
  const discoveredLocalMinimumOccurrenceCount = patterns.reduce((sum, pattern) => sum + pattern.discoveredLocalMinimumTransitStopIndexes.length, 0);
  const termination: MeetingSearchCoverageTermination = patterns.some((pattern) => pattern.eligibleStationOccurrenceCount > 0)
    ? "local-minima-discovered"
    : "no-transit-station-targets";
  return {
    method: MEETING_SEARCH_COVERAGE_METHOD,
    exhaustive: false,
    evaluatedStationOccurrenceCount,
    discoveredLocalMinimumOccurrenceCount,
    termination,
    patterns,
  };
}

function mergeQualifiedOccurrences(
  occurrences: readonly VerifiedOccurrence[],
  selectedTolerancePercent: TolerancePercent,
  effectiveTolerancePercent: number,
): FairLocation[] {
  const merged = new Map<string, { representative: VerifiedOccurrence; sourceRoutePatternIds: Set<string> }>();
  for (const occurrence of occurrences) {
    const stationId = occurrence.endpoint.stationGlobalId!;
    const existing = merged.get(stationId);
    if (existing) {
      existing.sourceRoutePatternIds.add(occurrence.patternId);
      if (compareVerifiedOccurrence(occurrence, existing.representative) < 0) existing.representative = occurrence;
      continue;
    }
    merged.set(stationId, { representative: occurrence, sourceRoutePatternIds: new Set([occurrence.patternId]) });
  }
  return [...merged.entries()].map(([stationId, value]) => {
    const representative = value.representative;
    return {
      id: `station:${stationId}`,
      label: representative.endpoint.label ?? `Transit stop ${stationId}`,
      kind: "station" as const,
      physicalIdentity: `station:${stationId}`,
      coordinate: representative.endpoint.coordinate,
      journeys: representative.journeys,
      differenceMilliseconds: representative.differenceMilliseconds,
      selectedTolerancePercent,
      effectiveTolerancePercent,
      sourceRoutePatternIds: [...value.sourceRoutePatternIds].sort(),
    };
  }).sort((left, right) => compareFairLocationOrder(
    fairLocationOrderKey(left.physicalIdentity, left.journeys),
    fairLocationOrderKey(right.physicalIdentity, right.journeys),
  ));
}

function compareVerifiedOccurrence(left: VerifiedOccurrence, right: VerifiedOccurrence): number {
  return left.patternId.localeCompare(right.patternId) || left.transitStopIndex - right.transitStopIndex;
}

function isFairPair(first: number, second: number, tolerancePercent: number): boolean {
  return 100 * Math.abs(first - second) <= tolerancePercent * (first + second);
}

function selectJourney(journeys: readonly CoordinateJourney[], arrivalAt: string): CoordinateJourney {
  if (journeys.length === 0) throw new ProviderUnavailableError("routing");
  journeys.forEach((journey) => validateJourney(journey, arrivalAt));
  return journeys.reduce((best, current) => {
    const bestDeparture = Date.parse(best.plannedDepartureAt);
    const currentDeparture = Date.parse(current.plannedDepartureAt);
    return currentDeparture > bestDeparture || (currentDeparture === bestDeparture && Date.parse(current.plannedArrivalAt) > Date.parse(best.plannedArrivalAt)) ? current : best;
  });
}

function toParticipantJourney(participant: MeetingParticipant, journey: CoordinateJourney, target: JourneyEndpoint, source: string): PlannedParticipantJourney {
  const parts = journey.parts.map((part) => ({
    ...part,
    from: normalizeJourneyEndpoint(part.from),
    to: normalizeJourneyEndpoint(part.to),
    intermediateStops: part.intermediateStops.map(normalizeJourneyEndpoint),
  }));
  return {
    participantId: participant.id,
    mode: "transit",
    origin: normalizeJourneyEndpoint(parts[0]!.from),
    destination: normalizeJourneyEndpoint(target),
    parts,
    plannedDepartureAt: journey.plannedDepartureAt,
    plannedArrivalAt: journey.plannedArrivalAt,
    plannedDurationMilliseconds: journey.plannedDurationMilliseconds,
    source,
  };
}

function createMetadata(routing: ProviderDescriptor): MeetingCalculationMetadata {
  const boundary = createBoundaryMetadata();
  return {
    routing,
    boundary,
    provenance: { routing: routing.provenance, boundary },
  };
}

function createBoundaryMetadata(): OfficialBoundaryMetadata {
  return {
    name: "OFFICIAL_MUNICH_STADTBEZIRKE_APPLICATION_COLLECTION",
    sourceUrl: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.sourceUrl,
    metadataUrl: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.metadataUrl,
    retrievedAt: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.retrievedAt,
    contentHash: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.normalizedContentHash,
    metadataContentHash: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.metadataContentHash,
    districtCount: 25,
    license: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.license,
    attribution: OFFICIAL_MUNICH_BOUNDARY_MANIFEST.attribution,
    legalBoundary: false,
  };
}

function normalizeJourneyCoordinates(journey: CoordinateJourney): CoordinateJourney {
  return {
    ...journey,
    transitStops: journey.transitStops.map(normalizeJourneyEndpoint),
    parts: journey.parts.map((part) => ({
      ...part,
      from: normalizeJourneyEndpoint(part.from),
      to: normalizeJourneyEndpoint(part.to),
      intermediateStops: part.intermediateStops.map(normalizeJourneyEndpoint),
    })),
  };
}

function normalizeJourneyEndpoint(endpoint: JourneyEndpoint): JourneyEndpoint {
  const label = typeof endpoint.label === "string" ? endpoint.label.trim() : "";
  return {
    stationGlobalId: endpoint.stationGlobalId,
    coordinate: coordinateOnly(endpoint.coordinate),
    ...(label.length > 0 && label.length <= MAX_LOCATION_LABEL_LENGTH ? { label } : {}),
  };
}

function coordinateOnly(coordinate: LocationCoordinate): LocationCoordinate {
  return { latitude: coordinate.latitude, longitude: coordinate.longitude };
}

function verificationKey(participantId: string, coordinate: LocationCoordinate): string {
  return `${participantId}\u0000${exactCoordinateKey(coordinate)}`;
}

function exactCoordinateKey(coordinate: LocationCoordinate): string {
  return `${coordinate.latitude}\u0000${coordinate.longitude}`;
}

function endpointIdentity(endpoint: JourneyEndpoint): string {
  return JSON.stringify({ stationGlobalId: endpoint.stationGlobalId, coordinate: endpoint.coordinate });
}

function provenanceKey(provenance: RoutePatternProvenance): string {
  return `${provenance.direction}|${provenance.searchKind}|${provenance.anchorStationGlobalId ?? "direct"}`;
}

function compareRepresentativeJourney(left: CoordinateJourney, right: CoordinateJourney): number {
  return right.plannedDepartureAt.localeCompare(left.plannedDepartureAt) ||
    right.plannedArrivalAt.localeCompare(left.plannedArrivalAt) ||
    right.plannedDurationMilliseconds - left.plannedDurationMilliseconds ||
    stableJourneySignature(left).localeCompare(stableJourneySignature(right));
}

function stableJourneySignature(journey: CoordinateJourney): string {
  return JSON.stringify(journey.parts.map((part) => ({
    kind: part.kind,
    from: endpointIdentity(part.from),
    to: endpointIdentity(part.to),
    intermediateStops: part.intermediateStops.map(endpointIdentity),
    line: part.line,
  })));
}

function isValidCoordinate(value: LocationCoordinate): boolean {
  return Number.isFinite(value.latitude) && Number.isFinite(value.longitude) && value.latitude >= -90 && value.latitude <= 90 && value.longitude >= -180 && value.longitude <= 180;
}

function coordinatesWithinMvgPrecision(first: LocationCoordinate, second: LocationCoordinate): boolean {
  return haversineDistanceKm(first, second) * 1_000 <= COORDINATE_BINDING_TOLERANCE_METRES;
}

function isCanonicalInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
