import { interpolateCoordinate, type ExactPoint } from "./geometry.ts";
import { normalizeRouteJourney, type RouteJourney } from "./models.ts";
import { Rational } from "./rational.ts";

export interface JourneyPosition {
  readonly tau: Rational;
  readonly segmentId: string;
  readonly fromOccurrenceIndex: number;
  readonly toOccurrenceIndex: number;
  readonly fraction: Rational;
  readonly coordinate: ExactPoint;
}

export interface JourneyMidpoint extends JourneyPosition {
  readonly pathDuration: Rational;
  readonly midpointTau: Rational;
}

export function journeyStartTau(journey: RouteJourney): Rational {
  return journey.occurrences[0]!.tau;
}

export function journeyEndTau(journey: RouteJourney): Rational {
  return journey.occurrences[journey.occurrences.length - 1]!.tau;
}

export function journeyDuration(journey: RouteJourney): Rational {
  return journeyEndTau(journey).subtract(journeyStartTau(journey));
}

function segmentAt(journey: RouteJourney, tau: Rational): { index: number; segment: RouteJourney["segments"][number] } {
  if (tau.compare(journeyStartTau(journey)) < 0 || tau.compare(journeyEndTau(journey)) > 0) {
    throw new Error("Journey time is outside the exact journey interval.");
  }
  for (const [index, segment] of journey.segments.entries()) {
    if (tau.compare(segment.arrivalTau) <= 0) return { index, segment };
  }
  const index = journey.segments.length - 1;
  return { index, segment: journey.segments[index]! };
}

export function journeyPositionAt(journey: RouteJourney, tau: Rational): JourneyPosition {
  const normalized = normalizeRouteJourney(journey);
  const { index, segment } = segmentAt(normalized, tau);
  const duration = segment.arrivalTau.subtract(segment.departureTau);
  const fraction = tau.subtract(segment.departureTau).divide(duration);
  const from = normalized.occurrences[index]!.coordinate;
  const to = normalized.occurrences[index + 1]!.coordinate;
  return Object.freeze({
    tau,
    segmentId: segment.id,
    fromOccurrenceIndex: segment.fromOccurrenceIndex,
    toOccurrenceIndex: segment.toOccurrenceIndex,
    fraction,
    coordinate: interpolateCoordinate(from, to, fraction),
  });
}

/** The midpoint is selected by cumulative journey time, never by vertex count or geometry length. */
export function canonicalJourneyMidpoint(journey: RouteJourney): JourneyMidpoint {
  const normalized = normalizeRouteJourney(journey);
  const duration = journeyDuration(normalized);
  const midpointTau = journeyStartTau(normalized).add(duration.divide(2));
  return Object.freeze({
    ...journeyPositionAt(normalized, midpointTau),
    pathDuration: duration,
    midpointTau,
  });
}

export function occurrenceSequence(journey: RouteJourney): readonly number[] {
  return journey.occurrences.map((occurrence) => occurrence.occurrenceIndex);
}
