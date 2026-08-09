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
  MeetingCalculationOkResponse,
  MeetingCalculationResponse,
  MeetingParticipant,
  MeetingSourceQueryProvenance,
  MeetingSearchDirection,
  OfficialBoundaryMetadata,
  PlannedParticipantJourney,
  ProviderDescriptor,
  RouteCandidateKind,
  RoutePattern,
  RoutePatternProvenance,
  RoutePatternSearchKind,
  TolerancePercent,
  TransitLineReference,
} from "./types.ts";
import { MEETING_TIME_ZONE } from "./types.ts";

export const MVG_ANCHOR_STATIONS = [
  { id: "de:09162:6", label: "Hauptbahnhof" },
  { id: "de:09162:50", label: "Sendlinger Tor" },
  { id: "de:09162:70", label: "Universität" },
  { id: "de:09162:1170", label: "Silberhornstraße" },
  { id: "de:09162:190", label: "Rotkreuzplatz" },
  { id: "de:09162:350", label: "Olympiazentrum" },
] as const;

const WALKING_ENDPOINT_MERGE_RADIUS_METRES = 50;
const MAX_LOCATION_LABEL_LENGTH = 512;
const MAX_PLANNED_JOURNEY_DURATION_MS = 24 * 60 * 60 * 1_000;
export const MEETING_CALCULATION_DEADLINE_MS = 12_000;
export const MAX_CANDIDATE_VERIFICATION_REQUESTS = 1_000;
export const COORDINATE_BINDING_TOLERANCE_METRES = 1;

export interface MeetingCalculationOptions {
  /** Test/deployment override; production uses the documented 12-second bound. */
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

export class NoFairLocationError extends Error {
  constructor() {
    super("MVG returned no qualifying Route-Derived Fair Location through the maximum tolerance.");
    this.name = "NoFairLocationError";
  }
}

interface RawCandidate {
  kind: RouteCandidateKind;
  label: string;
  physicalStationId: string | null;
  coordinate: LocationCoordinate;
  sourceRoutePatternIds: readonly string[];
  originParticipantId?: string;
  order: number;
}

interface VerifiedCandidate extends RawCandidate {
  journeys: readonly [PlannedParticipantJourney, PlannedParticipantJourney];
  differenceMilliseconds: number;
}

interface MutablePhysicalLocation {
  kind: RouteCandidateKind;
  physicalIdentity: string;
  coordinate: LocationCoordinate;
  sourceRoutePatternIds: Set<string>;
  representative: VerifiedCandidate;
}

/**
 * Calculate the finite Route-Derived Fair Location Set. The service never
 * calls a matrix, geocoder, POI provider, or route-first subsystem.
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

  const sourceRequests = createSourceRequests(arrivalAt, participants, signal);
  const sourceResults = await Promise.all(
    sourceRequests.map((request) => invokeJourneyProvider(journeyProvider, toProviderRequest(request))),
  );

  const patternMap = new Map<string, RoutePattern>();
  const rawCandidates: RawCandidate[] = [];
  let order = 0;
  sourceResults.forEach((result, sourceIndex) => {
    const source = sourceRequests[sourceIndex];
    result.journeys.forEach((rawJourney) => {
      const journey = normalizeJourneyCoordinates(rawJourney);
      validateJourney(journey, arrivalAt);
      const shapeKey = structuralShape(journey, source.direction).key;
      const isNewPattern = !patternMap.has(shapeKey);
      const pattern = upsertRoutePattern(
        patternMap,
        journey,
        source.direction,
        source.searchKind,
        source.anchorStationGlobalId,
      );
      if (isNewPattern) {
        const extractedCandidates = extractRawCandidates(journey, pattern.id, order);
        rawCandidates.push(...extractedCandidates);
        order += extractedCandidates.length;
      }
    });
  });

  for (const participant of participants) {
    if (!isWithinOfficialMunichBoundary(participant.location)) {
      throw new ResolvedLocationOutsideMunichError();
    }
    rawCandidates.push({
      kind: "origin",
      label: participant.location.label,
      physicalStationId: null,
      coordinate: coordinateOnly(participant.location),
      sourceRoutePatternIds: [...patternMap.values()].map((pattern) => pattern.id),
      originParticipantId: participant.id,
      order: order++,
    });
  }

  const munichCandidates = rawCandidates.filter((candidate) =>
    isWithinOfficialMunichBoundary(candidate.coordinate),
  );
  if (munichCandidates.length === 0 || patternMap.size === 0) {
    throw new NoFairLocationError();
  }
  const verificationRequests = munichCandidates.length * participants.length;
  const maxVerificationRequests = options.maxCandidateVerificationRequests ?? MAX_CANDIDATE_VERIFICATION_REQUESTS;
  if (verificationRequests > maxVerificationRequests) {
    throw new ProviderUnavailableError("routing");
  }

  // This is intentionally before physical merging: two occurrences of the
  // same station or endpoint are separate provider checks.
  const verified = await Promise.all(
    munichCandidates.map(async (candidate) => {
      const journeys: [
        Awaited<ReturnType<typeof invokeJourneyProvider>>,
        Awaited<ReturnType<typeof invokeJourneyProvider>>,
      ] = await Promise.all([
        invokeJourneyProvider(journeyProvider, {
          origin: participants[0].location,
          destination: candidate.coordinate,
          arrivalAt,
          signal,
        }),
        invokeJourneyProvider(journeyProvider, {
          origin: participants[1].location,
          destination: candidate.coordinate,
          arrivalAt,
          signal,
        }),
      ]);
      return verifyCandidate(candidate, participants, journeys, arrivalAt, journeyProvider.descriptor.name);
    }),
  );

  let qualifying: VerifiedCandidate[] = [];
  let effectiveTolerancePercent = input.tolerancePercent;
  for (let tolerance = input.tolerancePercent; tolerance <= 100; tolerance += 5) {
    const current = verified.filter((candidate) =>
      isFairPair(
        candidate.journeys[0].plannedDurationMilliseconds,
        candidate.journeys[1].plannedDurationMilliseconds,
        tolerance,
      ),
    );
    if (current.length > 0) {
      qualifying = current;
      effectiveTolerancePercent = tolerance;
      break;
    }
  }
  if (qualifying.length === 0) throw new NoFairLocationError();

  const fairLocations = mergeQualifiedCandidates(
    qualifying,
    input.tolerancePercent,
    effectiveTolerancePercent,
  );
  const routing = journeyProvider.descriptor;
  const response: MeetingCalculationOkResponse = {
    contractVersion: "meeet-meeting/v2" as const,
    status: "ok" as const,
    requestSnapshot: {
      participants,
      arrivalAt,
      selectedTolerancePercent: input.tolerancePercent,
      effectiveTolerancePercent,
      timeZone: MEETING_TIME_ZONE,
    },
    fairLocations,
    routePatterns: [...patternMap.values()],
    sourceQueries: sourceResults.map((result, index) => toSourceQueryProvenance(sourceRequests[index], result)),
    metadata: createMetadata(routing),
  };

  // The public DTO intentionally has no corridor/POI/legacy approximate fields.
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

interface SourceRequest extends CoordinateJourneyRequest {
  direction: MeetingSearchDirection;
  searchKind: RoutePatternSearchKind;
  anchorStationGlobalId: string | null;
  originParticipantId: string;
  destinationParticipantId: string;
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
      const previous = journey.parts[index - 1];
      if (previous.to.stationGlobalId !== null && part.from.stationGlobalId !== null && previous.to.stationGlobalId !== part.from.stationGlobalId) {
        throw new ProviderUnavailableError("routing");
      }
      if (Date.parse(part.plannedDepartureAt) < Date.parse(previous.plannedArrivalAt)) {
        throw new ProviderUnavailableError("routing");
      }
    }
    if (part.kind === "transit" && (!part.line || typeof part.line.identity !== "string" || typeof part.line.type !== "string" || !part.from.stationGlobalId || !part.to.stationGlobalId)) {
      throw new ProviderUnavailableError("routing");
    }
    if (!Array.isArray(part.intermediateStops) || part.intermediateStops.some((stop: JourneyEndpoint) => !stop || typeof stop.stationGlobalId !== "string" || !stop.stationGlobalId || !isValidCoordinate(stop.coordinate))) {
      throw new ProviderUnavailableError("routing");
    }
    if (part.kind === "walking" && part.line !== null) {
      throw new ProviderUnavailableError("routing");
    }
  });
  if (journey.parts[0].plannedDepartureAt !== journey.plannedDepartureAt || journey.parts.at(-1)!.plannedArrivalAt !== journey.plannedArrivalAt) {
    throw new ProviderUnavailableError("routing");
  }
}

function upsertRoutePattern(
  patterns: Map<string, RoutePattern>,
  journey: CoordinateJourney,
  direction: MeetingSearchDirection,
  searchKind: RoutePatternSearchKind,
  anchorStationGlobalId: string | null,
): RoutePattern {
  const shape = structuralShape(journey, direction);
  const existing = patterns.get(shape.key);
  const provenance: RoutePatternProvenance = { direction, searchKind, anchorStationGlobalId };
  if (existing) {
    if (!existing.provenance.some((item) => JSON.stringify(item) === JSON.stringify(provenance))) {
      const updated = { ...existing, provenance: [...existing.provenance, provenance] };
      patterns.set(shape.key, updated);
      return updated;
    }
    return existing;
  }
  const pattern: RoutePattern = {
    id: `route-pattern:${stableHash(shape.key)}`,
    kind: shape.kind,
    transitStops: shape.transitStops,
    lines: shape.lines,
    parts: journey.parts,
    provenance: [provenance],
  };
  patterns.set(shape.key, pattern);
  return pattern;
}

function structuralShape(journey: CoordinateJourney, direction: MeetingSearchDirection): {
  key: string;
  kind: "transit" | "walk-only";
  transitStops: readonly JourneyEndpoint[];
  lines: readonly TransitLineReference[];
} {
  const parts = journey.parts;
  const transitParts = parts.filter((part) => part.kind === "transit");
  if (transitParts.length === 0) {
    const endpoints = parts.flatMap((part) => [part.from, part.to]);
    const key = `walk-only:${JSON.stringify({ direction, endpoints: endpoints.map(endpointIdentity) })}`;
    return { key, kind: "walk-only", transitStops: [], lines: [] };
  }
  const stops: JourneyEndpoint[] = [];
  const lines: TransitLineReference[] = [];
  for (const part of transitParts) {
    stops.push(part.from, ...part.intermediateStops, part.to);
    if (part.line) lines.push(part.line);
  }
  const key = `transit:${JSON.stringify({ stops: stops.map((stop) => stop.stationGlobalId), lines: lines.map((line) => [line.identity, line.type]) })}`;
  return { key, kind: "transit", transitStops: stops, lines };
}

function extractRawCandidates(journey: CoordinateJourney, patternId: string, order: number): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  let nextOrder = order;
  for (const part of journey.parts) {
    const endpoints = part.kind === "transit"
      ? [part.from, ...part.intermediateStops, part.to]
      : [part.from, part.to];
    for (const endpoint of endpoints) {
      if (!isWithinOfficialMunichBoundary(endpoint.coordinate)) continue;
      candidates.push({
        kind: endpoint.stationGlobalId ? "station" : "walking-endpoint",
        label: endpoint.label ?? (endpoint.stationGlobalId ? `Transit stop ${endpoint.stationGlobalId}` : "Walking endpoint"),
        physicalStationId: endpoint.stationGlobalId,
        coordinate: endpoint.coordinate,
        sourceRoutePatternIds: [patternId],
        order: nextOrder++,
      });
    }
  }
  return candidates;
}

function verifyCandidate(
  candidate: RawCandidate,
  participants: readonly [MeetingParticipant, MeetingParticipant],
  results: readonly [{ journeys: readonly CoordinateJourney[]; source: string }, { journeys: readonly CoordinateJourney[]; source: string }],
  arrivalAt: string,
  fallbackSource: string,
): VerifiedCandidate {
  const selected = results.map((result) => selectJourney(result.journeys, arrivalAt));
  const journeys: [PlannedParticipantJourney, PlannedParticipantJourney] = [
    toParticipantJourney(participants[0], selected[0], results[0].source || fallbackSource),
    toParticipantJourney(participants[1], selected[1], results[1].source || fallbackSource),
  ];
  return {
    ...candidate,
    journeys,
    differenceMilliseconds: Math.abs(journeys[0].plannedDurationMilliseconds - journeys[1].plannedDurationMilliseconds),
  };
}

function selectJourney(journeys: readonly CoordinateJourney[], arrivalAt: string): CoordinateJourney {
  if (journeys.length === 0) throw new ProviderUnavailableError("routing");
  journeys.forEach((journey) => validateJourney(journey, arrivalAt));
  return journeys.reduce((best, current) => {
    const bestDeparture = Date.parse(best.plannedDepartureAt);
    const currentDeparture = Date.parse(current.plannedDepartureAt);
    return currentDeparture > bestDeparture ||
      (currentDeparture === bestDeparture && Date.parse(current.plannedArrivalAt) > Date.parse(best.plannedArrivalAt))
      ? current
      : best;
  });
}

function toParticipantJourney(participant: MeetingParticipant, journey: CoordinateJourney, source: string): PlannedParticipantJourney {
  return {
    participantId: participant.id,
    mode: "transit",
    plannedDepartureAt: journey.plannedDepartureAt,
    plannedArrivalAt: journey.plannedArrivalAt,
    plannedDurationMilliseconds: journey.plannedDurationMilliseconds,
    source,
  };
}

function isFairPair(first: number, second: number, tolerancePercent: number): boolean {
  return 100 * Math.abs(first - second) <= tolerancePercent * (first + second);
}

function mergeQualifiedCandidates(
  candidates: readonly VerifiedCandidate[],
  selectedTolerancePercent: TolerancePercent,
  effectiveTolerancePercent: number,
): FairLocation[] {
  const merged: MutablePhysicalLocation[] = [];
  const orderedCandidates = [...candidates].sort(compareCandidatePhysicalOrder);
  for (const candidate of orderedCandidates) {
    const existing = merged.find((location) => samePhysicalLocation(location, candidate));
    if (existing) {
      candidate.sourceRoutePatternIds.forEach((id) => existing.sourceRoutePatternIds.add(id));
      continue;
    }
    const kind = candidate.kind;
    const physicalIdentity = kind === "station"
      ? `station:${candidate.physicalStationId}`
      : kind === "origin"
        ? `origin:${stableHash(`${candidate.coordinate.latitude}:${candidate.coordinate.longitude}`)}`
        : `walking-endpoint:${stableHash(`${candidate.coordinate.latitude}:${candidate.coordinate.longitude}`)}`;
    merged.push({
      kind,
      physicalIdentity,
      coordinate: candidate.coordinate,
      sourceRoutePatternIds: new Set(candidate.sourceRoutePatternIds),
      representative: candidate,
    });
  }
  return merged.map((location) => {
    const representative = location.representative;
    return {
      id: location.physicalIdentity,
      label: representative.label,
      kind: location.kind,
      physicalIdentity: location.physicalIdentity,
      coordinate: location.coordinate,
      journeys: representative.journeys,
      differenceMilliseconds: representative.differenceMilliseconds,
      selectedTolerancePercent,
      effectiveTolerancePercent,
      sourceRoutePatternIds: [...location.sourceRoutePatternIds],
    };
  });
}

function compareCandidatePhysicalOrder(left: VerifiedCandidate, right: VerifiedCandidate): number {
  const kindOrder: Record<RouteCandidateKind, number> = { station: 0, origin: 1, "walking-endpoint": 2 };
  return kindOrder[left.kind] - kindOrder[right.kind] ||
    (left.physicalStationId ?? "").localeCompare(right.physicalStationId ?? "") ||
    left.coordinate.latitude - right.coordinate.latitude ||
    left.coordinate.longitude - right.coordinate.longitude ||
    left.order - right.order;
}

function samePhysicalLocation(location: MutablePhysicalLocation, candidate: VerifiedCandidate): boolean {
  if (location.kind === "station" && candidate.kind === "station") return location.physicalIdentity === `station:${candidate.physicalStationId}`;
  if (location.kind === "station" || candidate.kind === "station") return false;
  return haversineDistanceKm(location.coordinate, candidate.coordinate) * 1_000 <= WALKING_ENDPOINT_MERGE_RADIUS_METRES;
}

function createMetadata(routing: ProviderDescriptor): MeetingCalculationMetadata {
  const boundary = createBoundaryMetadata();
  return {
    routing,
    boundary,
    provenance: {
      routing: routing.provenance,
      boundary,
    },
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

function endpointIdentity(endpoint: JourneyEndpoint): string {
  return JSON.stringify({ stationGlobalId: endpoint.stationGlobalId, coordinate: endpoint.coordinate });
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
