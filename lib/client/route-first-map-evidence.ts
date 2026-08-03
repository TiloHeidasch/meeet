import proj4 from "proj4";

import {
  assertRouteFirstClientCompleteResult,
  canonicalRouteFirstClientJourneyPathKey,
  ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE,
  type RouteFirstClientCompleteResult,
  type RouteFirstClientCoordinate,
  type RouteFirstClientCorridor,
  type RouteFirstClientFamily,
  type RouteFirstClientJourney,
} from "../domain/route-first/client-contract.ts";
import { Rational } from "../domain/route-first/rational.ts";

export const ROUTE_FIRST_EPSG_25832_DEFINITION = "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs" as const;
export const ROUTE_FIRST_MAP_OUTPUT_REFERENCE = Object.freeze({ crs: "EPSG:4326", unit: "degree" } as const);

proj4.defs("EPSG:25832", ROUTE_FIRST_EPSG_25832_DEFINITION);

const MUNICH_BBOX = Object.freeze({ minLongitude: 11, maxLongitude: 12, minLatitude: 47.5, maxLatitude: 48.6 });
const MAX_PROJECTED_METRES = Rational.from(10_000_000);

export type RouteFirstMapLineSource = "directional-route" | "alternate-route" | "corridor" | "fair-region";
export type RouteFirstMapPointSource = "midpoint" | "fair-region-point";

export interface RouteFirstMapLineString {
  readonly type: "LineString";
  readonly coordinates: readonly (readonly [number, number])[];
}

export interface RouteFirstMapPointGeometry {
  readonly type: "Point";
  readonly coordinates: readonly [number, number];
}

export interface RouteFirstMapLine {
  readonly source: RouteFirstMapLineSource;
  readonly participantId?: string;
  readonly journeyId?: string;
  readonly familyPathKey?: string;
  readonly componentId?: string;
  readonly edgeId?: string;
  readonly interval?: { readonly start: string; readonly end: string };
  readonly geometry: RouteFirstMapLineString;
}

export interface RouteFirstMapPoint {
  readonly source: RouteFirstMapPointSource;
  readonly participantId?: string;
  readonly journeyId?: string;
  readonly familyPathKey?: string;
  readonly edgeId?: string;
  readonly geometry: RouteFirstMapPointGeometry;
}

export interface RouteFirstMapJourneyText {
  readonly participantId: string;
  readonly journeyId: string;
  readonly familyPathKey: string;
  readonly role: "primary" | "alternate";
  readonly startTau: string;
  readonly endTau: string;
  readonly modes: readonly string[];
  readonly text: string;
}

export interface RouteFirstMapFamilySelection {
  readonly familyIndex: number;
  readonly contextKey: string;
  readonly skeletonKey: string;
  readonly geometryKey: string;
}

export interface RouteFirstMapEvidence {
  readonly coordinateReference: typeof ROUTE_FIRST_MAP_OUTPUT_REFERENCE;
  readonly sourceCoordinateReference: typeof ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE;
  readonly familyIndex: number;
  readonly familyIdentity: Pick<RouteFirstMapFamilySelection, "contextKey" | "skeletonKey" | "geometryKey">;
  readonly lines: readonly RouteFirstMapLine[];
  readonly points: readonly RouteFirstMapPoint[];
  readonly selectedJourneys: readonly RouteFirstMapJourneyText[];
}

function compareCoordinate(left: RouteFirstClientCoordinate, right: RouteFirstClientCoordinate): boolean {
  return left.xMm === right.xMm && left.yMm === right.yMm;
}

function rational(value: string): Rational | null {
  try {
    return Rational.from(value);
  } catch {
    return null;
  }
}

function exactCoordinate(xMm: Rational, yMm: Rational): RouteFirstClientCoordinate | null {
  return { xMm: xMm.toString(), yMm: yMm.toString() };
}

function projectedMetres(value: string): number | null {
  const millimetres = rational(value);
  if (!millimetres) return null;
  const metres = millimetres.divide(1_000);
  if (metres.abs().compare(MAX_PROJECTED_METRES) > 0) return null;
  const numerator = Number(metres.numerator);
  const denominator = Number(metres.denominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

function projectCoordinate(coordinate: RouteFirstClientCoordinate): readonly [number, number] | null {
  const easting = projectedMetres(coordinate.xMm);
  const northing = projectedMetres(coordinate.yMm);
  if (easting === null || northing === null) return null;
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  try {
    const transformed = proj4("EPSG:25832", "EPSG:4326", [easting, northing]);
    const longitude = transformed[0];
    const latitude = transformed[1];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 ||
      longitude < MUNICH_BBOX.minLongitude || longitude > MUNICH_BBOX.maxLongitude || latitude < MUNICH_BBOX.minLatitude || latitude > MUNICH_BBOX.maxLatitude) return null;
    return [longitude, latitude];
  } catch {
    return null;
  }
}

function lineGeometry(coordinates: readonly RouteFirstClientCoordinate[]): RouteFirstMapLineString | null {
  const projected: Array<readonly [number, number]> = [];
  for (const coordinate of coordinates) {
    const point = projectCoordinate(coordinate);
    if (!point) return null;
    const previous = projected[projected.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) projected.push(point);
  }
  return projected.length >= 2 ? { type: "LineString", coordinates: projected } : null;
}

function pointGeometry(coordinate: RouteFirstClientCoordinate): RouteFirstMapPointGeometry | null {
  const point = projectCoordinate(coordinate);
  return point ? { type: "Point", coordinates: point } : null;
}

function journeyGeometry(journey: RouteFirstClientJourney): readonly RouteFirstClientCoordinate[] {
  const points: RouteFirstClientCoordinate[] = [];
  for (const segment of journey.segments) for (const point of segment.geometry) {
    if (!points[points.length - 1] || !compareCoordinate(points[points.length - 1]!, point)) points.push(point);
  }
  return points;
}

function intervalGeometry(
  journey: RouteFirstClientJourney,
  corridor: RouteFirstClientCorridor,
): readonly RouteFirstClientCoordinate[] | null {
  const start = rational(corridor.exact.startTau);
  const end = rational(corridor.exact.endTau);
  if (!start || !end || start.compare(end) >= 0) return null;
  const directionalGeometry = corridor.directionalGeometry;
  const expectedGeometry = journeyGeometry(journey);
  if (directionalGeometry.length !== expectedGeometry.length || directionalGeometry.some((point, index) => !compareCoordinate(point, expectedGeometry[index]!))) return null;
  const journeyStart = rational(journey.occurrences[0]?.tau ?? "");
  const journeyEnd = rational(journey.occurrences[journey.occurrences.length - 1]?.tau ?? "");
  if (!journeyStart || !journeyEnd || start.compare(journeyStart) < 0 || end.compare(journeyEnd) > 0) return null;
  const clipped: RouteFirstClientCoordinate[] = [];
  const add = (point: RouteFirstClientCoordinate): void => {
    if (!clipped[clipped.length - 1] || !compareCoordinate(clipped[clipped.length - 1]!, point)) clipped.push(point);
  };
  let previousOverlapEnd: Rational | null = null;
  for (const [index, segment] of journey.segments.entries()) {
    const segmentStart = rational(journey.occurrences[index]!.tau);
    const segmentEnd = rational(journey.occurrences[index + 1]!.tau);
    const from = rational(segment.geometry[0]?.xMm ?? "");
    const to = rational(segment.geometry[1]?.xMm ?? "");
    const fromY = rational(segment.geometry[0]?.yMm ?? "");
    const toY = rational(segment.geometry[1]?.yMm ?? "");
    const fromOccurrence = journey.occurrences[index]?.coordinate;
    const toOccurrence = journey.occurrences[index + 1]?.coordinate;
    if (!segmentStart || !segmentEnd || !from || !to || !fromY || !toY || !fromOccurrence || !toOccurrence || segment.geometry.length !== 2 ||
      segmentStart.compare(segmentEnd) >= 0 || !compareCoordinate(segment.geometry[0]!, fromOccurrence) || !compareCoordinate(segment.geometry[1]!, toOccurrence)) return null;
    const overlapStart = start.compare(segmentStart) > 0 ? start : segmentStart;
    const overlapEnd = end.compare(segmentEnd) < 0 ? end : segmentEnd;
    if (overlapStart.compare(overlapEnd) >= 0) continue;
    if (previousOverlapEnd && overlapStart.compare(previousOverlapEnd) !== 0) return null;
    const startFraction = overlapStart.subtract(segmentStart).divide(segmentEnd.subtract(segmentStart));
    const endFraction = overlapEnd.subtract(segmentStart).divide(segmentEnd.subtract(segmentStart));
    add(exactCoordinate(from.add(to.subtract(from).multiply(startFraction)), fromY.add(toY.subtract(fromY).multiply(startFraction)))!);
    add(exactCoordinate(from.add(to.subtract(from).multiply(endFraction)), fromY.add(toY.subtract(fromY).multiply(endFraction)))!);
    previousOverlapEnd = overlapEnd;
  }
  if (!previousOverlapEnd || previousOverlapEnd.compare(end) !== 0) return null;
  return clipped.length >= 2 ? clipped : null;
}

function coordinateAtParameter(
  start: RouteFirstClientCoordinate,
  end: RouteFirstClientCoordinate,
  parameter: string,
): RouteFirstClientCoordinate | null {
  const x0 = rational(start.xMm);
  const x1 = rational(end.xMm);
  const y0 = rational(start.yMm);
  const y1 = rational(end.yMm);
  const t = rational(parameter);
  if (!x0 || !x1 || !y0 || !y1 || !t || t.isNegative() || t.compare(1) > 0) return null;
  return exactCoordinate(x0.add(x1.subtract(x0).multiply(t)), y0.add(y1.subtract(y0).multiply(t)));
}

function fairRegionContainsInterval(
  region: RouteFirstClientCompleteResult["fairRegions"][number],
  interval: { readonly start: string; readonly end: string },
): boolean {
  const start = rational(interval.start);
  const end = rational(interval.end);
  if (!start || !end || start.compare(end) > 0) return false;
  const containedInInterval = region.intervals.some((candidate) => {
    const candidateStart = rational(candidate.start);
    const candidateEnd = rational(candidate.end);
    return !!candidateStart && !!candidateEnd && candidateStart.compare(start) <= 0 && candidateEnd.compare(end) >= 0;
  });
  if (containedInInterval) return true;
  if (!start.equals(end)) return false;
  return region.points.some((point) => rational(point)?.equals(start) ?? false);
}

function validateSelection(result: RouteFirstClientCompleteResult, selection: RouteFirstMapFamilySelection): RouteFirstClientFamily {
  if (!Number.isSafeInteger(selection.familyIndex) || selection.familyIndex < 0 || typeof selection.contextKey !== "string" || typeof selection.skeletonKey !== "string" || typeof selection.geometryKey !== "string") throw new Error("Route-first map family selection is invalid.");
  const family = result.families[selection.familyIndex];
  if (!family || family.contextKey !== selection.contextKey || family.skeletonKey !== selection.skeletonKey || family.geometryKey !== selection.geometryKey) throw new Error("Route-first map family selection is not bound to the complete result.");
  return family;
}

function journeyText(journey: RouteFirstClientJourney, pathKey: string, role: "primary" | "alternate"): RouteFirstMapJourneyText {
  const startTau = journey.occurrences[0]!.tau;
  const endTau = journey.occurrences[journey.occurrences.length - 1]!.tau;
  const modes = [...new Set(journey.segments.map((segment) => segment.mode))];
  return { participantId: journey.participantId, journeyId: journey.id, familyPathKey: pathKey, role, startTau, endTau, modes, text: `${journey.participantId}: ${role} journey ${journey.id} (${modes.join(" → ")}), ${startTau}–${endTau}` };
}

export function buildRouteFirstMapEvidence(value: unknown, selection: RouteFirstMapFamilySelection): RouteFirstMapEvidence {
  const result = assertRouteFirstClientCompleteResult(value);
  const family = validateSelection(result, selection);
  const selectedPathKeys = new Set(family.pathKeys);
  const lines: RouteFirstMapLine[] = [];
  const points: RouteFirstMapPoint[] = [];
  const selectedJourneys: RouteFirstMapJourneyText[] = [];
  const selectedJourneyCandidates = result.journeys.filter((journey) => selectedPathKeys.has(canonicalRouteFirstClientJourneyPathKey(journey)));
  if (selectedJourneyCandidates.length !== family.pathKeys.length || new Set(selectedJourneyCandidates.map((journey) => canonicalRouteFirstClientJourneyPathKey(journey))).size !== family.pathKeys.length) throw new Error("Selected family paths are not fully bound to certified journeys.");
  const roleByJourneyId = new Map<string, "primary" | "alternate">();
  for (const participantId of result.provenance.participantIds) {
    const participantJourneys = selectedJourneyCandidates.filter((journey) => journey.participantId === participantId).sort((left, right) => {
      const leftKey = canonicalRouteFirstClientJourneyPathKey(left);
      const rightKey = canonicalRouteFirstClientJourneyPathKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    participantJourneys.forEach((journey, index) => roleByJourneyId.set(journey.id, index === 0 ? "primary" : "alternate"));
  }

  for (const journey of selectedJourneyCandidates) {
    const pathKey = canonicalRouteFirstClientJourneyPathKey(journey);
    const role = roleByJourneyId.get(journey.id);
    if (!role) throw new Error("Selected journey lacks a deterministic participant role.");
    const route = lineGeometry(journeyGeometry(journey));
    if (!route) throw new Error("Selected journey geometry is unsafe for map evidence.");
    lines.push({ source: role === "alternate" ? "alternate-route" : "directional-route", participantId: journey.participantId, journeyId: journey.id, familyPathKey: pathKey, geometry: route });
    selectedJourneys.push(journeyText(journey, pathKey, role));
    const corridor = result.corridors.find((candidate) => candidate.journeyId === journey.id && candidate.participantId === journey.participantId);
    if (!corridor) throw new Error("Selected journey lacks a certified corridor.");
    const clipped = intervalGeometry(journey, corridor);
    const clippedLine = clipped ? lineGeometry(clipped) : null;
    if (!clippedLine) throw new Error("Selected journey corridor cannot be safely clipped.");
    lines.push({ source: "corridor", participantId: journey.participantId, journeyId: journey.id, familyPathKey: pathKey, geometry: clippedLine });
    const midpoint = pointGeometry(corridor.midpoint.coordinate);
    if (!midpoint) throw new Error("Selected journey midpoint is unsafe for map evidence.");
    points.push({ source: "midpoint", participantId: journey.participantId, journeyId: journey.id, familyPathKey: pathKey, geometry: midpoint });
  }

  for (const component of family.eligibleComponents) {
    for (const edgeInterval of component.edgeIntervals) {
      if (!family.targetEdgeIds.includes(edgeInterval.edgeId)) continue;
      const region = result.fairRegions.find((candidate) => candidate.edgeId === edgeInterval.edgeId);
      if (!region || !fairRegionContainsInterval(region, edgeInterval.interval)) continue;
      const start = coordinateAtParameter(region.geometry.start, region.geometry.end, edgeInterval.interval.start);
      const end = coordinateAtParameter(region.geometry.start, region.geometry.end, edgeInterval.interval.end);
      if (!start || !end) continue;
      const geometry = lineGeometry([start, end]);
      if (geometry) lines.push({ source: "fair-region", componentId: component.id, edgeId: edgeInterval.edgeId, interval: edgeInterval.interval, geometry });
      else if (edgeInterval.interval.start === edgeInterval.interval.end) {
        const point = pointGeometry(start);
        if (point) points.push({ source: "fair-region-point", edgeId: edgeInterval.edgeId, geometry: point });
      }
    }
  }

  return {
    coordinateReference: ROUTE_FIRST_MAP_OUTPUT_REFERENCE,
    sourceCoordinateReference: ROUTE_FIRST_CLIENT_COORDINATE_REFERENCE,
    familyIndex: selection.familyIndex,
    familyIdentity: { contextKey: family.contextKey, skeletonKey: family.skeletonKey, geometryKey: family.geometryKey },
    lines: Object.freeze(lines),
    points: Object.freeze(points),
    selectedJourneys: Object.freeze(selectedJourneys),
  };
}
