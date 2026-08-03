import { sameSnapshot, type ExactInterval, type RouteSnapshotIdentity, validateSnapshot } from "./models.ts";
import { Rational, type RationalInput } from "./rational.ts";

export interface AffineTimeSegment {
  readonly edgeId: string;
  readonly startParam: Rational;
  readonly endParam: Rational;
  readonly startTime: Rational;
  readonly endTime: Rational;
  readonly occurrenceIndex: number;
}

export interface StationaryTargetOccurrence {
  readonly participantId: string;
  readonly edgeId: string;
  readonly param: Rational;
  readonly startTime: Rational;
  readonly endTime: Rational;
  readonly occurrenceIndex: number;
  readonly kind: "dwell" | "wait";
}

export interface TargetTimeProfile {
  readonly participantId: string;
  readonly participantIds: readonly string[];
  readonly snapshot: RouteSnapshotIdentity;
  readonly edgeId: string;
  readonly timingModel: "piecewise-linear";
  readonly segments: readonly AffineTimeSegment[];
  readonly stationaryOccurrences?: readonly StationaryTargetOccurrence[];
}

export interface FairRegionScope {
  readonly kind: "pair" | "all-participants";
  readonly participantIds: readonly string[];
}

export interface FairRegion {
  readonly edgeId: string;
  readonly participantIds: readonly string[];
  readonly snapshot: RouteSnapshotIdentity;
  readonly scope: FairRegionScope;
  readonly kind: "exact" | "tolerance";
  readonly tolerancePercent: Rational;
  readonly intervals: readonly ExactInterval[];
  readonly points: readonly Rational[];
  readonly stationaryOccurrences: readonly StationaryTargetOccurrence[];
}

export function rationalMedian(values: readonly Rational[]): Rational {
  if (values.length === 0) return Rational.zero();
  const sorted = [...values].sort((left, right) => left.compare(right));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return sorted[middle - 1]!.add(sorted[middle]!).divide(2);
}

export function exactMidpoint(values: readonly Rational[]): Rational {
  if (values.length === 0) return Rational.zero();
  return values.reduce((total, value) => total.add(value), Rational.zero()).divide(values.length);
}

function validateProfile(profile: TargetTimeProfile): void {
  validateSnapshot(profile.snapshot);
  if (!profile.participantId || !profile.edgeId || profile.timingModel !== "piecewise-linear" || profile.segments.length === 0 ||
    profile.participantIds.length < 2 || new Set(profile.participantIds).size !== profile.participantIds.length ||
    profile.participantIds.some((participantId, index) => !participantId.trim() || (index > 0 && profile.participantIds[index - 1]! > participantId)) ||
    !profile.participantIds.includes(profile.participantId)) throw new Error("Target time profile is incomplete or lacks an exact participant/snapshot model.");
  let previousEnd: Rational | null = null;
  let previousTime: Rational | null = null;
  for (const [index, segment] of profile.segments.entries()) {
    for (const [value, label] of [
      [segment.startParam, "startParam"], [segment.endParam, "endParam"],
      [segment.startTime, "startTime"], [segment.endTime, "endTime"],
    ] as const) if (!(value instanceof Rational)) throw new Error(`Profile ${label} must be Rational.`);
    if (segment.edgeId !== profile.edgeId || segment.occurrenceIndex !== index || segment.startParam.isNegative() || segment.endParam.compare(1) > 0 ||
      segment.startParam.compare(segment.endParam) >= 0 || segment.startTime.isNegative() || segment.endTime.isNegative() ||
      (previousEnd !== null && (segment.startParam.compare(previousEnd) !== 0 || segment.startTime.compare(previousTime!) !== 0))) {
      throw new Error("Target time profile segments must be ordered, complete, and edge-bound.");
    }
    previousEnd = segment.endParam;
    previousTime = segment.endTime;
  }
  if (profile.segments[0]!.startParam.compare(0) !== 0 || previousEnd?.compare(1) !== 0) {
    throw new Error("Target time profile must start at zero and cover the complete target edge.");
  }
  for (const occurrence of profile.stationaryOccurrences ?? []) {
    if (occurrence.participantId !== profile.participantId || occurrence.edgeId !== profile.edgeId || occurrence.param.isNegative() || occurrence.param.compare(1) > 0 ||
      occurrence.endTime.compare(occurrence.startTime) < 0 || occurrence.startTime.compare(valueAtUnchecked(profile, occurrence.param)) !== 0) {
      throw new Error("Stationary target occurrence is invalid or not participant-specific.");
    }
  }
}

function segmentAt(profile: TargetTimeProfile, param: Rational): AffineTimeSegment {
  const segment = profile.segments.find((candidate) => param.compare(candidate.startParam) >= 0 && param.compare(candidate.endParam) <= 0);
  if (!segment) throw new Error("Target parameter is outside a complete time profile.");
  return segment;
}

function valueAtUnchecked(profile: TargetTimeProfile, param: Rational): Rational {
  const segment = segmentAt(profile, param);
  return segment.startTime.add(segment.endTime.subtract(segment.startTime).multiply(param.subtract(segment.startParam).divide(segment.endParam.subtract(segment.startParam))));
}

export function targetTimeAt(profile: TargetTimeProfile, param: Rational): Rational {
  validateProfile(profile);
  const segment = segmentAt(profile, param);
  const parameterSpan = segment.endParam.subtract(segment.startParam);
  const timeSpan = segment.endTime.subtract(segment.startTime);
  return segment.startTime.add(timeSpan.multiply(param.subtract(segment.startParam).divide(parameterSpan)));
}

function breakpoints(profiles: readonly TargetTimeProfile[], start: Rational, end: Rational): Rational[] {
  const values = [start, end];
  for (const profile of profiles) for (const segment of profile.segments) {
    if (segment.startParam.compare(start) > 0 && segment.startParam.compare(end) < 0) values.push(segment.startParam);
    if (segment.endParam.compare(start) > 0 && segment.endParam.compare(end) < 0) values.push(segment.endParam);
  }
  return values.sort((left, right) => left.compare(right)).filter((value, index, all) => index === 0 || value.compare(all[index - 1]!) !== 0);
}

function addPoint(points: Rational[], point: Rational): void {
  if (!points.some((candidate) => candidate.compare(point) === 0)) points.push(point);
}

function mergeIntervals(intervals: readonly ExactInterval[]): ExactInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start.compare(right.start));
  const merged: ExactInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start.compare(previous.end) <= 0) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: interval.end.compare(previous.end) > 0 ? interval.end : previous.end,
      };
    } else merged.push(interval);
  }
  return merged;
}

function canonicalPoints(points: readonly Rational[], intervals: readonly ExactInterval[]): Rational[] {
  return points.filter((point, index, all) =>
    !intervals.some((interval) => point.compare(interval.start) >= 0 && point.compare(interval.end) <= 0) &&
    all.findIndex((candidate) => candidate.compare(point) === 0) === index,
  ).sort((left, right) => left.compare(right));
}

function profileDomain(profiles: readonly TargetTimeProfile[]): { edgeId: string; start: Rational; end: Rational; participantIds: readonly string[]; snapshot: RouteSnapshotIdentity } {
  if (profiles.length === 0) throw new Error("At least one target time profile is required.");
  profiles.forEach(validateProfile);
  if (profiles.length < 2) throw new Error("At least two distinct participants are required for a fair region.");
  const participantIds = new Set(profiles.map((profile) => profile.participantId));
  if (participantIds.size !== profiles.length) throw new Error("Fair profiles must have distinct participant identities.");
  const canonicalParticipants = [...profiles[0]!.participantIds];
  if (profiles.some((profile) => profile.participantIds.length !== canonicalParticipants.length || profile.participantIds.some((id, index) => id !== canonicalParticipants[index]))) {
    throw new Error("Fair profiles must bind to one canonical participant set.");
  }
  const profileParticipants = [...participantIds].sort();
  if (profileParticipants.length !== canonicalParticipants.length || profileParticipants.some((participantId, index) => participantId !== canonicalParticipants[index])) {
    throw new Error("Fair profiles must form an exact participant bijection.");
  }
  const snapshot = profiles[0]!.snapshot;
  if (profiles.some((profile) => !sameSnapshot(profile.snapshot, snapshot))) throw new Error("Fair profiles must share one snapshot identity.");
  const edgeId = profiles[0]!.edgeId;
  if (profiles.some((profile) => profile.edgeId !== edgeId)) throw new Error("Fair profiles must share one target edge.");
  return { edgeId, start: Rational.zero(), end: Rational.one(), participantIds: canonicalParticipants, snapshot };
}

function stationaryInRegion(
  profiles: readonly TargetTimeProfile[],
  intervals: readonly ExactInterval[],
  points: readonly Rational[],
): StationaryTargetOccurrence[] {
  const occurrences = profiles.flatMap((profile) => profile.stationaryOccurrences ?? []).filter((occurrence) =>
    intervals.some((interval) => occurrence.param.compare(interval.start) >= 0 && occurrence.param.compare(interval.end) <= 0) ||
    points.some((point) => occurrence.param.compare(point) === 0),
  );
  const seen = new Set<string>();
  return occurrences.filter((occurrence) => {
    const key = `${occurrence.participantId}:${occurrence.edgeId}:${occurrence.occurrenceIndex}:${occurrence.param.toString()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function regionForDifference(left: TargetTimeProfile, right: TargetTimeProfile): FairRegion {
  const domain = profileDomain([left, right]);
  const intervals: ExactInterval[] = [];
  const points: Rational[] = [];
  const cuts = breakpoints([left, right], domain.start, domain.end);
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index]!;
    const end = cuts[index + 1]!;
    const startDifference = targetTimeAt(left, start).subtract(targetTimeAt(right, start));
    const endDifference = targetTimeAt(left, end).subtract(targetTimeAt(right, end));
    if (startDifference.isZero() && endDifference.isZero()) intervals.push({ start, end });
    else {
      if (startDifference.isZero()) addPoint(points, start);
      if (endDifference.isZero()) addPoint(points, end);
      if (startDifference.compare(0) * endDifference.compare(0) < 0) {
        const root = start.subtract(startDifference.multiply(end.subtract(start)).divide(endDifference.subtract(startDifference)));
        addPoint(points, root);
      }
    }
  }
  const mergedIntervals = mergeIntervals(intervals);
  const sortedPoints = canonicalPoints(points, mergedIntervals);
  return Object.freeze({ edgeId: domain.edgeId, participantIds: Object.freeze([...domain.participantIds]), snapshot: domain.snapshot, scope: Object.freeze({ kind: "pair" as const, participantIds: Object.freeze([...domain.participantIds]) }), kind: "exact", tolerancePercent: Rational.zero(), intervals: Object.freeze(mergedIntervals), points: Object.freeze(sortedPoints), stationaryOccurrences: Object.freeze(stationaryInRegion([left, right], mergedIntervals, sortedPoints)) });
}

function pairwiseCrossingCuts(
  profiles: readonly TargetTimeProfile[],
  domain: { start: Rational; end: Rational },
): Rational[] {
  const cuts: Rational[] = [];
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex]!;
      const right = profiles[rightIndex]!;
      const pairCuts = breakpoints([left, right], domain.start, domain.end);
      for (let index = 0; index < pairCuts.length - 1; index += 1) {
        const start = pairCuts[index]!;
        const end = pairCuts[index + 1]!;
        const startDifference = valueAtUnchecked(left, start).subtract(valueAtUnchecked(right, start));
        const endDifference = valueAtUnchecked(left, end).subtract(valueAtUnchecked(right, end));
        if (startDifference.isZero()) addPoint(cuts, start);
        if (endDifference.isZero()) addPoint(cuts, end);
        if (startDifference.compare(0) * endDifference.compare(0) < 0) {
          addPoint(cuts, start.subtract(startDifference.multiply(end.subtract(start)).divide(endDifference.subtract(startDifference))));
        }
      }
    }
  }
  return cuts.sort((left, right) => left.compare(right));
}

export function pairExactMidpointRegion(left: TargetTimeProfile, right: TargetTimeProfile): FairRegion {
  return regionForDifference(left, right);
}

export function allParticipantExactRegion(profiles: readonly TargetTimeProfile[]): FairRegion {
  const domain = profileDomain(profiles);
  const cuts = breakpoints(profiles, domain.start, domain.end);
  const intervals: ExactInterval[] = [];
  const points: Rational[] = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index]!;
    const end = cuts[index + 1]!;
    const startValues = profiles.map((profile) => targetTimeAt(profile, start));
    const endValues = profiles.map((profile) => targetTimeAt(profile, end));
    if (startValues.every((value) => value.equals(startValues[0]!)) && endValues.every((value) => value.equals(endValues[0]!))) {
      intervals.push({ start, end });
    } else {
      const candidates = [start, end];
      const baseline = profiles[0]!;
      for (const profile of profiles.slice(1)) {
        const a = targetTimeAt(baseline, start).subtract(targetTimeAt(profile, start));
        const b = targetTimeAt(baseline, end).subtract(targetTimeAt(profile, end));
        if (a.isZero()) candidates.push(start);
        if (b.isZero()) candidates.push(end);
        if (a.compare(0) * b.compare(0) < 0) candidates.push(start.subtract(a.multiply(end.subtract(start)).divide(b.subtract(a))));
      }
      for (const candidate of candidates) {
        const values = profiles.map((profile) => targetTimeAt(profile, candidate));
        if (values.every((value) => value.equals(values[0]!))) addPoint(points, candidate);
      }
    }
  }
  const mergedIntervals = mergeIntervals(intervals);
  const sortedPoints = canonicalPoints(points, mergedIntervals);
  const stationaryOccurrences = stationaryInRegion(profiles, mergedIntervals, sortedPoints).filter((occurrence) => {
    const values = profiles.map((profile) => targetTimeAt(profile, occurrence.param));
    return values.every((value) => value.equals(values[0]!));
  });
  return Object.freeze({ edgeId: domain.edgeId, participantIds: Object.freeze([...domain.participantIds]), snapshot: domain.snapshot, scope: Object.freeze({ kind: "all-participants" as const, participantIds: Object.freeze([...domain.participantIds]) }), kind: "exact", tolerancePercent: Rational.zero(), intervals: Object.freeze(mergedIntervals), points: Object.freeze(sortedPoints), stationaryOccurrences: Object.freeze(stationaryOccurrences) });
}

export function medianAt(profiles: readonly TargetTimeProfile[], param: Rational): Rational {
  return rationalMedian(profiles.map((profile) => targetTimeAt(profile, param)));
}

function medianAtUnchecked(profiles: readonly TargetTimeProfile[], param: Rational): Rational {
  return rationalMedian(profiles.map((profile) => valueAtUnchecked(profile, param)));
}

function toleranceSatisfied(profiles: readonly TargetTimeProfile[], param: Rational, tolerance: Rational): boolean {
  const times = profiles.map((profile) => valueAtUnchecked(profile, param));
  const median = rationalMedian(times);
  const lower = median.multiply(Rational.one().subtract(tolerance.divide(100)));
  const upper = median.multiply(Rational.one().add(tolerance.divide(100)));
  return times.every((time) => time.compare(lower) >= 0 && time.compare(upper) <= 0);
}

/** Exact all-participant ±tolerance region, including isolated roots and intervals. */
export function allParticipantToleranceRegion(
  profiles: readonly TargetTimeProfile[],
  tolerancePercent: RationalInput = 10,
): FairRegion {
  const domain = profileDomain(profiles);
  const tolerance = Rational.from(tolerancePercent);
  if (tolerance.isNegative() || tolerance.compare(100) > 0) throw new Error("Fair tolerance must be within [0, 100].");
  const cuts = breakpoints(profiles, domain.start, domain.end);
  for (const point of pairwiseCrossingCuts(profiles, domain)) if (point.compare(0) > 0 && point.compare(1) < 0) cuts.push(point);
  const sortedCuts = cuts.sort((left, right) => left.compare(right)).filter((value, index, all) => index === 0 || value.compare(all[index - 1]!) !== 0);
  const intervals: ExactInterval[] = [];
  const points: Rational[] = [];
  for (let index = 0; index < sortedCuts.length - 1; index += 1) {
    const start = sortedCuts[index]!;
    const end = sortedCuts[index + 1]!;
    const localCuts = [start, end];
    const lowerMultiplier = Rational.one().subtract(tolerance.divide(100));
    const upperMultiplier = Rational.one().add(tolerance.divide(100));
    for (const profile of profiles) for (const multiplier of [lowerMultiplier, upperMultiplier]) {
      const startDifference = valueAtUnchecked(profile, start).subtract(medianAtUnchecked(profiles, start).multiply(multiplier));
      const endDifference = valueAtUnchecked(profile, end).subtract(medianAtUnchecked(profiles, end).multiply(multiplier));
      if (startDifference.compare(0) * endDifference.compare(0) < 0) {
        localCuts.push(start.subtract(startDifference.multiply(end.subtract(start)).divide(endDifference.subtract(startDifference))));
      }
    }
    const uniqueCuts = localCuts.sort((left, right) => left.compare(right)).filter((value, cutIndex, all) => cutIndex === 0 || value.compare(all[cutIndex - 1]!) !== 0);
    for (let localIndex = 0; localIndex < uniqueCuts.length - 1; localIndex += 1) {
      const localStart = uniqueCuts[localIndex]!;
      const localEnd = uniqueCuts[localIndex + 1]!;
      const localStartGood = toleranceSatisfied(profiles, localStart, tolerance);
      const localEndGood = toleranceSatisfied(profiles, localEnd, tolerance);
      if (localStartGood && localEndGood) intervals.push({ start: localStart, end: localEnd });
      else {
        if (localStartGood) addPoint(points, localStart);
        if (localEndGood) addPoint(points, localEnd);
      }
    }
  }
  const mergedIntervals = mergeIntervals(intervals);
  const sortedPoints = canonicalPoints(points, mergedIntervals);
  return Object.freeze({
    edgeId: domain.edgeId,
    participantIds: Object.freeze([...domain.participantIds]),
    snapshot: domain.snapshot,
    scope: Object.freeze({ kind: "all-participants" as const, participantIds: Object.freeze([...domain.participantIds]) }),
    kind: "tolerance",
    tolerancePercent: tolerance,
    intervals: Object.freeze(mergedIntervals),
    points: Object.freeze(sortedPoints),
    stationaryOccurrences: Object.freeze(stationaryInRegion(profiles, mergedIntervals, sortedPoints)),
  });
}
