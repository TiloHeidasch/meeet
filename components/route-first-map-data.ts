import type { RouteFirstMapEvidence, RouteFirstMapLine, RouteFirstMapPoint } from "@/lib/client/route-first-map-evidence";

export type MapEvidencePointFeature = { type: "Feature"; id: string; properties: Record<string, string | number>; geometry: { type: "Point"; coordinates: [number, number] } };
export type MapEvidenceLineFeature = { type: "Feature"; id: string; properties: Record<string, string>; geometry: { type: "LineString"; coordinates: [number, number][] } };

export function routeFirstLineFeatureId(item: RouteFirstMapLine, index: number): string {
  return ["line", item.source, item.participantId ?? "", item.journeyId ?? "", item.familyPathKey ?? "", item.componentId ?? "", item.edgeId ?? "", item.interval?.start ?? "", item.interval?.end ?? "", index].join("|");
}

export function routeFirstPointFeatureId(item: RouteFirstMapPoint, index: number): string {
  return ["point", item.source, item.participantId ?? "", item.journeyId ?? "", item.familyPathKey ?? "", item.edgeId ?? "", index].join("|");
}

export function routeFirstLineData(evidence: RouteFirstMapEvidence | null | undefined): { type: "FeatureCollection"; features: MapEvidenceLineFeature[] } {
  return { type: "FeatureCollection", features: (evidence?.lines ?? []).map((item: RouteFirstMapLine, index) => ({ type: "Feature", id: routeFirstLineFeatureId(item, index), properties: { kind: item.source, participantId: item.participantId ?? "" }, geometry: { type: "LineString", coordinates: item.geometry.coordinates.map((coordinate) => [coordinate[0], coordinate[1]] as [number, number]) } })) };
}

export function routeFirstPointData(evidence: RouteFirstMapEvidence | null | undefined): { type: "FeatureCollection"; features: MapEvidencePointFeature[] } {
  return { type: "FeatureCollection", features: (evidence?.points ?? []).map((item: RouteFirstMapPoint, index) => ({ type: "Feature", id: routeFirstPointFeatureId(item, index), properties: { kind: item.source, participantId: item.participantId ?? "" }, geometry: { type: "Point", coordinates: [item.geometry.coordinates[0], item.geometry.coordinates[1]] } })) };
}
