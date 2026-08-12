"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { AttributionControl, Map, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MeetingCell } from "@/lib/client/meeting-response";

export type MapParticipant = { id: string; number: number; label: string; latitude: number; longitude: number; color: "#e85d4a" | "#3d70c9" };
export type ParticipantMapCoordinate = { latitude: number; longitude: number };
type PolygonFeature = { type: "Feature"; id: string; properties: { classification: "red" | "blue" | "fair" }; geometry: MeetingCell["geometry"] };
type PolygonCollection = { type: "FeatureCollection"; features: PolygonFeature[] };
type Props = { participants: readonly MapParticipant[]; cells: readonly MeetingCell[]; onParticipantMove: (id: string, coordinate: ParticipantMapCoordinate) => void; resultState: "initial" | "ok" | "no-result" };

const MUNICH_CENTER: [number, number] = [11.576, 48.137];
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
setWorkerUrl("/vendor/maplibre-gl/maplibre-gl-worker.mjs");

function cellsData(cells: readonly MeetingCell[]): PolygonCollection {
  return { type: "FeatureCollection", features: cells.filter((cell): cell is MeetingCell & { classification: "red" | "blue" | "fair" } => cell.classification !== "unclassified").map((cell) => ({ type: "Feature", id: cell.id, properties: { classification: cell.classification }, geometry: cell.geometry })) };
}
function syncMarkers(map: Map, participants: readonly MapParticipant[], markers: MutableRefObject<globalThis.Map<string, Marker>>, move: (id: string, coordinate: ParticipantMapCoordinate) => void) {
  const ids = new Set(participants.map((p) => p.id));
  markers.current.forEach((marker, id) => { if (!ids.has(id)) { marker.remove(); markers.current.delete(id); } });
  participants.forEach((p) => {
    let marker = markers.current.get(p.id);
    if (!marker) {
      const element = document.createElement("button"); element.type = "button"; element.className = "meeet-origin-marker"; element.textContent = String(p.number); element.style.backgroundColor = p.color; element.setAttribute("aria-label", `${p.label} origin. Drag to adjust.`); element.title = "Drag to adjust this origin";
      marker = new Marker({ element, draggable: true }).setLngLat([p.longitude, p.latitude]).addTo(map); marker.on("dragend", () => { const point = marker!.getLngLat(); move(p.id, { latitude: point.lat, longitude: point.lng }); }); markers.current.set(p.id, marker);
    } else marker.setLngLat([p.longitude, p.latitude]);
  });
}

export default function MapLibreCanvas({ participants, cells, onParticipantMove, resultState }: Props) {
  const containerRef = useRef<HTMLDivElement>(null); const mapRef = useRef<Map | null>(null); const markersRef = useRef(new globalThis.Map<string, Marker>()); const inputs = useRef({ participants, onParticipantMove });
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading"); const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL; const attribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION;
  useEffect(() => { inputs.current = { participants, onParticipantMove }; }, [participants, onParticipantMove]);
  useEffect(() => {
    if (!containerRef.current) { setState("unavailable"); return; } let active = true; let map: Map | null = null;
    try {
      map = new Map({ container: containerRef.current, style: styleUrl, center: MUNICH_CENTER, zoom: 11, attributionControl: false }); mapRef.current = map; map.addControl(new AttributionControl({ compact: true, customAttribution: attribution }), "bottom-right"); map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.once("style.load", () => { if (!map || !active) return; map.addSource("meeet-surface", { type: "geojson", data: cellsData([]) }); map.addLayer({ id: "meeet-surface-red", type: "fill", source: "meeet-surface", filter: ["==", ["get", "classification"], "red"], paint: { "fill-color": "#e85d4a", "fill-opacity": .52, "fill-outline-color": "#d84a3b" } }); map.addLayer({ id: "meeet-surface-blue", type: "fill", source: "meeet-surface", filter: ["==", ["get", "classification"], "blue"], paint: { "fill-color": "#3d70c9", "fill-opacity": .5, "fill-outline-color": "#315ca8" } }); map.addLayer({ id: "meeet-surface-fair", type: "fill", source: "meeet-surface", filter: ["==", ["get", "classification"], "fair"], paint: { "fill-color": "#f0ca43", "fill-opacity": .72, "fill-outline-color": "#d5ae25" } }); syncMarkers(map, inputs.current.participants, markersRef, (id, coordinate) => inputs.current.onParticipantMove(id, coordinate)); });
      map.on("load", () => { if (active) setState("ready"); }); map.on("error", () => { if (active) setState("unavailable"); });
    } catch { queueMicrotask(() => { if (active) setState("unavailable"); }); }
    return () => { active = false; markersRef.current.forEach((marker) => marker.remove()); markersRef.current.clear(); map?.remove(); mapRef.current = null; };
  }, [styleUrl, attribution]);
  useEffect(() => { const map = mapRef.current; if (!map || state !== "ready") return; const source = map.getSource("meeet-surface") as GeoJSONSource | undefined; if (!source) return; const data = cellsData(cells); source.setData(data); const layers = ["meeet-surface-red", "meeet-surface-blue", "meeet-surface-fair"]; const classifications = data.features.map((feature) => feature.properties.classification).sort().join(","); const existingLayers = layers.filter((layer) => Boolean(map.getLayer(layer))).join(","); containerRef.current?.parentElement?.setAttribute("data-map-update", `source:${classifications};layers:${existingLayers}`); syncMarkers(map, participants, markersRef, onParticipantMove); }, [cells, participants, onParticipantMove, state]);
  const label = resultState === "ok" ? "Munich meeting surface with red, blue and yellow travel-time cells" : "Munich meeting map with two participant origins";
  const featureCounts = cells.reduce((counts, cell) => { if (cell.classification !== "unclassified") counts[cell.classification] += 1; return counts; }, { red: 0, blue: 0, fair: 0 });
  return <section className="map-frame" aria-label={label} data-map-state={state} data-surface-features={`red:${featureCounts.red},blue:${featureCounts.blue},fair:${featureCounts.fair}`}><h2 className="sr-only">Munich meeting map</h2><div ref={containerRef} className="absolute inset-0" />{state === "loading" && <div className="map-message" role="status">Loading Munich map…</div>}{state === "unavailable" && <div className="map-message" role="status"><strong>Map unavailable</strong><span>The meeting result is still available as a surface summary.</span></div>}</section>;
}
