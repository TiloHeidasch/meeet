import { canonicalJourneyMidpoint, journeyDuration, journeyEndTau, journeyStartTau, type JourneyMidpoint } from "./journey.ts";
import { canonicalId, normalizeRouteJourney, sameSnapshot, type RouteEnumerationInput, type RouteEnumerationPolicy, type RouteJourney, type RouteJourneyRequestContext, validateSnapshot } from "./models.ts";
import { canonicalEnumeratedRoutePathKey, canonicalEnumerationPolicyKey, verifyEnumerationCertificate, type CompleteRouteEnumeration, type EnumeratedRoutePath } from "./enumeration.ts";
import { Rational, type RationalInput } from "./rational.ts";

export interface TemporalCorridorInterval {
  readonly label: "exact-temporal-corridor" | "ambiguity-envelope";
  readonly startTau: Rational;
  readonly endTau: Rational;
  readonly tolerancePercent: Rational;
}

export interface ExactTemporalCorridor {
  readonly midpoint: JourneyMidpoint;
  readonly exact: TemporalCorridorInterval;
  readonly ambiguityEnvelope: TemporalCorridorInterval | null;
  readonly constituentCorridors: readonly TemporalCorridorInterval[];
}

export interface RouteFamilyRequestContext {
  readonly familyKey: string;
  readonly request: RouteJourneyRequestContext;
  readonly policy: RouteEnumerationPolicy;
}

export interface CompleteAlternateRegionCertificate {
  readonly complete: true;
  readonly family: RouteFamilyRequestContext;
  readonly enumerationInput: RouteEnumerationInput;
  readonly enumeration: CompleteRouteEnumeration;
  readonly path: EnumeratedRoutePath;
  readonly journey: RouteJourney;
}

export interface TemporalCorridorOptions {
  readonly context: RouteFamilyRequestContext;
  readonly alternates: readonly CompleteAlternateRegionCertificate[];
}

function sameRequestContext(left: RouteJourneyRequestContext, right: RouteJourneyRequestContext): boolean {
  return left.participantId === right.participantId && left.originVertexId === right.originVertexId &&
    left.destinationVertexId === right.destinationVertexId && left.departureContext === right.departureContext &&
    sameSnapshot(left.snapshot, right.snapshot);
}

function validateFamilyContext(context: RouteFamilyRequestContext): void {
  canonicalId(context.familyKey, "route family key");
  canonicalId(context.request.participantId, "route family participantId");
  canonicalId(context.request.originVertexId, "route family originVertexId");
  canonicalId(context.request.destinationVertexId, "route family destinationVertexId");
  canonicalId(context.request.departureContext, "route family departureContext");
  validateSnapshot(context.request.snapshot);
  validateSnapshot(context.policy.snapshot);
  if (context.request.originVertexId === context.request.destinationVertexId) throw new Error("Route family request origin and destination must differ.");
  if (!sameSnapshot(context.request.snapshot, context.policy.snapshot)) throw new Error("Route family request and policy snapshots must match.");
  canonicalEnumerationPolicyKey(context.policy);
}

function sameFamilyContext(left: RouteFamilyRequestContext, right: RouteFamilyRequestContext): boolean {
  return left.familyKey === right.familyKey && sameRequestContext(left.request, right.request) &&
    canonicalEnumerationPolicyKey(left.policy) === canonicalEnumerationPolicyKey(right.policy);
}

function pathMatchesJourney(path: EnumeratedRoutePath, journey: RouteJourney): boolean {
  return path.vertexIds.length === journey.path.vertexIds.length && path.edgeIds.length === journey.path.edgeIds.length &&
    path.vertexIds.every((vertexId, index) => vertexId === journey.path.vertexIds[index]) &&
    path.edgeIds.every((edgeId, index) => edgeId === journey.path.edgeIds[index]);
}

function validateAlternateEvidence(
  alternate: CompleteAlternateRegionCertificate,
  context: RouteFamilyRequestContext,
  journey: RouteJourney,
): void {
  if (!alternate.complete) throw new Error("Ambiguity envelopes require complete alternate evidence.");
  normalizeRouteJourney(alternate.journey);
  validateFamilyContext(alternate.family);
  if (!sameFamilyContext(alternate.family, context) || !sameRequestContext(alternate.journey.requestContext, context.request) ||
    !sameSnapshot(alternate.journey.snapshot, journey.snapshot) || alternate.journey.participantId !== journey.participantId ||
    !sameSnapshot(alternate.enumerationInput.policy.snapshot, context.policy.snapshot) ||
    canonicalEnumerationPolicyKey(alternate.enumerationInput.policy) !== canonicalEnumerationPolicyKey(context.policy) ||
    alternate.enumerationInput.originVertexIds.length !== 1 || alternate.enumerationInput.originVertexIds[0] !== context.request.originVertexId ||
    alternate.enumerationInput.targetVertexIds.length !== 1 || alternate.enumerationInput.targetVertexIds[0] !== context.request.destinationVertexId ||
    !pathMatchesJourney(alternate.path, alternate.journey)) {
    throw new Error("Ambiguity envelope evidence has unrelated participant, request, snapshot, policy, or journey provenance.");
  }
  verifyEnumerationCertificate(alternate.enumerationInput, alternate.enumeration);
  if (alternate.enumeration.status !== "complete" ||
    !alternate.enumeration.paths.some((path) => canonicalEnumeratedRoutePathKey(path) === canonicalEnumeratedRoutePathKey(alternate.path))) {
    throw new Error("Ambiguity envelope evidence path is not a member of the verified complete enumeration.");
  }
}

export function exactTemporalCorridor(
  journey: RouteJourney,
  tolerancePercent: RationalInput = 10,
  options?: TemporalCorridorOptions,
): ExactTemporalCorridor {
  const midpoint = canonicalJourneyMidpoint(journey);
  const tolerance = Rational.from(tolerancePercent);
  if (tolerance.isNegative() || tolerance.compare(100) > 0) throw new Error("Corridor tolerance must be within [0, 100].");
  const duration = journeyDuration(journey);
  // The tolerance is the full width of the symmetric corridor: ±10% means 45–55%.
  const margin = duration.multiply(tolerance).divide(200);
  const exactStart = midpoint.midpointTau.subtract(margin).compare(journeyStartTau(journey)) < 0
    ? journeyStartTau(journey)
    : midpoint.midpointTau.subtract(margin);
  const exactEnd = midpoint.midpointTau.add(margin).compare(journeyEndTau(journey)) > 0
    ? journeyEndTau(journey)
    : midpoint.midpointTau.add(margin);
  if (options && (options.alternates.length === 0)) {
    throw new Error("Ambiguity envelopes require certified alternate-family corridors.");
  }
  if (options) {
    validateFamilyContext(options.context);
    if (!sameRequestContext(journey.requestContext, options.context.request) || !sameSnapshot(journey.snapshot, options.context.request.snapshot)) {
      throw new Error("Ambiguity envelope context is unrelated to the primary journey.");
    }
  }
  const alternateCorridors = options?.alternates.map((alternate) => {
    validateAlternateEvidence(alternate, options.context, journey);
    return exactTemporalCorridor(alternate.journey, tolerancePercent);
  }) ?? [];
  const constituentCorridors = Object.freeze([
    Object.freeze({ label: "exact-temporal-corridor" as const, startTau: exactStart, endTau: exactEnd, tolerancePercent: tolerance }),
    ...alternateCorridors.map((corridor) => corridor.exact),
  ]);
  const envelopeStart = constituentCorridors.map((corridor) => corridor.startTau).reduce((left, right) => left.compare(right) < 0 ? left : right);
  const envelopeEnd = constituentCorridors.map((corridor) => corridor.endTau).reduce((left, right) => left.compare(right) > 0 ? left : right);
  return Object.freeze({
    midpoint,
    exact: Object.freeze({ label: "exact-temporal-corridor", startTau: exactStart, endTau: exactEnd, tolerancePercent: tolerance }),
    ambiguityEnvelope: options
      ? Object.freeze({ label: "ambiguity-envelope" as const, startTau: envelopeStart, endTau: envelopeEnd, tolerancePercent: tolerance })
      : null,
    constituentCorridors,
  });
}
