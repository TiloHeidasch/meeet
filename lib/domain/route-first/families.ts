import {
  canonicalTopologyStructuralKey,
  normalizeEligibleTargetComponent,
  type EligibleTargetComponent,
} from "./topology.ts";
import { sameSnapshot, validateSnapshot, type RouteSnapshotIdentity } from "./models.ts";

export type EligibleRouteComponent = EligibleTargetComponent;

export interface MeaningfulRouteFamily {
  readonly snapshot: RouteSnapshotIdentity;
  readonly contextKey: string;
  readonly skeletonKey: string;
  readonly geometryKey: string;
  readonly eligibleComponents: readonly EligibleRouteComponent[];
  readonly diversityClusters?: readonly (readonly string[])[];
}

export interface ComponentMatching {
  readonly leftId: string;
  readonly rightId: string;
}

export interface RouteFamilyComparison {
  readonly equal: boolean;
  readonly reason: "matched" | "context-mismatch" | "skeleton-mismatch" | "geometry-mismatch" | "snapshot-mismatch" | "component-multiset-mismatch";
  readonly matching: readonly ComponentMatching[];
  readonly diversityClusters: readonly (readonly string[])[];
}

function strictKey(value: string, label: string): void {
  if (!value || value.trim() !== value || /\s/.test(value)) throw new Error(`${label} must be a non-empty canonical key.`);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalRouteComponentKey(component: EligibleRouteComponent): string {
  return canonicalTopologyStructuralKey(normalizeEligibleTargetComponent(component));
}

function componentFrequency(components: readonly EligibleRouteComponent[], snapshot: RouteSnapshotIdentity): Map<string, { count: number; ids: string[] }> {
  const frequency = new Map<string, { count: number; ids: string[] }>();
  for (const component of components) {
    const normalized = normalizeEligibleTargetComponent(component);
    if (!sameSnapshot(normalized.snapshot, snapshot)) {
      throw new Error(`Route component ${normalized.id} has a mismatched snapshot identity.`);
    }
    const key = canonicalTopologyStructuralKey(normalized);
    const entry = frequency.get(key) ?? { count: 0, ids: [] };
    entry.count += 1;
    entry.ids.push(normalized.id);
    frequency.set(key, entry);
  }
  for (const entry of frequency.values()) entry.ids.sort(compareCanonical);
  return frequency;
}

function normalizedClusters(family: MeaningfulRouteFamily): readonly (readonly string[])[] {
  return Object.freeze((family.diversityClusters ?? []).map((cluster) => Object.freeze([...cluster].sort(compareCanonical))));
}

export function compareMeaningfulRouteFamilies(left: MeaningfulRouteFamily, right: MeaningfulRouteFamily): RouteFamilyComparison {
  validateSnapshot(left.snapshot);
  validateSnapshot(right.snapshot);
  strictKey(left.contextKey, "left contextKey");
  strictKey(left.skeletonKey, "left skeletonKey");
  strictKey(left.geometryKey, "left geometryKey");
  strictKey(right.contextKey, "right contextKey");
  strictKey(right.skeletonKey, "right skeletonKey");
  strictKey(right.geometryKey, "right geometryKey");
  const diversityClusters = Object.freeze([...normalizedClusters(left), ...normalizedClusters(right)]);
  const metadata = { diversityClusters };
  if (!sameSnapshot(left.snapshot, right.snapshot)) return { equal: false, reason: "snapshot-mismatch", matching: [], ...metadata };
  if (left.contextKey !== right.contextKey) return { equal: false, reason: "context-mismatch", matching: [], ...metadata };
  if (left.skeletonKey !== right.skeletonKey) return { equal: false, reason: "skeleton-mismatch", matching: [], ...metadata };
  if (left.geometryKey !== right.geometryKey) return { equal: false, reason: "geometry-mismatch", matching: [], ...metadata };
  const leftFrequency = componentFrequency(left.eligibleComponents, left.snapshot);
  const rightFrequency = componentFrequency(right.eligibleComponents, right.snapshot);
  if (leftFrequency.size !== rightFrequency.size || [...leftFrequency.keys()].some((key) => leftFrequency.get(key)!.count !== rightFrequency.get(key)?.count)) {
    return { equal: false, reason: "component-multiset-mismatch", matching: [], ...metadata };
  }
  const matching: ComponentMatching[] = [];
  for (const [key, leftEntry] of leftFrequency) {
    const rightEntry = rightFrequency.get(key)!;
    for (let index = 0; index < leftEntry.ids.length; index += 1) matching.push({ leftId: leftEntry.ids[index]!, rightId: rightEntry.ids[index]! });
  }
  matching.sort((a, b) => compareCanonical(a.leftId, b.leftId));
  return { equal: true, reason: "matched", matching: Object.freeze(matching), ...metadata };
}
