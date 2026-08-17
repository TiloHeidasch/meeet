"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { AttributionControl, Map, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MeetingStationArea } from "@/lib/client/meeting-response";
import { buildStationTerritories, type StationTerritory } from "@/lib/client/station-territories";

export type MapParticipant = { id: string; number: number; label: string; latitude: number; longitude: number; color: "#e85d4a" | "#3d70c9" };
type Props = { participants: readonly MapParticipant[]; stationAreas: readonly MeetingStationArea[]; resultState: "initial" | "ok" | "no-result"; selectedStationAreaId?: string | null; onStationAreaSelect?: (stationAreaId: string) => void };
type Geometry = { type: "MultiPolygon"; coordinates: number[][][][] } | { type: "Point"; coordinates: [number, number] };
type FeatureCollection = { type: "FeatureCollection"; features: Array<{ type: "Feature"; id: string; properties: Record<string, string>; geometry: Geometry }> };
const MUNICH_CENTER: [number, number] = [11.576, 48.137];
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const TERRITORY_FILL_OPACITY = 0.4;
const STATION_LAYERS = ["meeet-stations-red", "meeet-stations-blue", "meeet-stations-fair", "meeet-stations-unclassified"];
const STATION_COLORS = { red: "#e85d4a", blue: "#3d70c9", fair: "#f0ca43", unclassified: "#65716a" } as const;
setWorkerUrl("/vendor/maplibre-gl/maplibre-gl-worker.mjs");

function territoryData(areas: readonly MeetingStationArea[], resultState: Props["resultState"]): FeatureCollection {
  if (resultState !== "ok" || areas.length === 0 || areas.every((area) => area.classification === "unclassified")) return { type: "FeatureCollection", features: [] };
  return { type: "FeatureCollection", features: (buildStationTerritories(areas) as readonly StationTerritory[]).filter((territory) => territory.classification !== "unclassified").map((territory) => ({ type: "Feature", id: territory.stationAreaId, properties: { classification: territory.classification }, geometry: territory.geometry as unknown as Geometry })) };
}
function stationData(areas: readonly MeetingStationArea[]): FeatureCollection { return { type: "FeatureCollection", features: areas.map((area) => ({ type: "Feature", id: area.stationAreaId, properties: { classification: area.classification, stationAreaId: area.stationAreaId, name: area.name }, geometry: { type: "Point", coordinates: [area.coordinate.longitude, area.coordinate.latitude] } })) }; }

/** A padded, high-DPI diamond image keeps the visible station marker compact while providing a comfortable hit target. */
function stationDiamondImage(color: string): ImageData {
  const pixelRatio = 2;
  const visualSize = 16;
  const padding = 12;
  const canvas = document.createElement("canvas");
  canvas.width = (visualSize + padding * 2) * pixelRatio;
  canvas.height = canvas.width;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(canvas.width, canvas.height);
  context.scale(pixelRatio, pixelRatio);
  const center = canvas.width / pixelRatio / 2;
  const radius = visualSize / 2;
  context.beginPath();
  context.moveTo(center, center - radius);
  context.lineTo(center + radius, center);
  context.lineTo(center, center + radius);
  context.lineTo(center - radius, center);
  context.closePath();
  context.lineJoin = "miter";
  context.lineWidth = 2;
  context.strokeStyle = "#fffdf8";
  context.fillStyle = color;
  context.fill();
  context.stroke();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** A high-DPI diamond outline indicator for the selected station area. */
function selectedStationOutlineImage(): ImageData {
  const pixelRatio = 2;
  const visualSize = 24;
  const padding = 8;
  const canvas = document.createElement("canvas");
  canvas.width = (visualSize + padding * 2) * pixelRatio;
  canvas.height = canvas.width;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(canvas.width, canvas.height);
  context.scale(pixelRatio, pixelRatio);
  const center = canvas.width / pixelRatio / 2;
  const radius = visualSize / 2;
  context.beginPath();
  context.moveTo(center, center - radius);
  context.lineTo(center + radius, center);
  context.lineTo(center, center + radius);
  context.lineTo(center - radius, center);
  context.closePath();
  context.lineJoin = "miter";
  context.lineWidth = 3;
  context.strokeStyle = "#202522";
  context.stroke();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
function syncOrigins(map: Map, participants: readonly MapParticipant[], markers: MutableRefObject<globalThis.Map<string, Marker>>) {
  const ids = new Set(participants.map((p) => p.id));
  markers.current.forEach((marker, id) => { if (!ids.has(id)) { marker.remove(); markers.current.delete(id); } });
  participants.forEach((p) => { let marker = markers.current.get(p.id); if (!marker) { const element = document.createElement("button"); element.type = "button"; element.className = "meeet-origin-marker"; element.textContent = String(p.number); element.style.backgroundColor = p.color; element.setAttribute("aria-label", `${p.label} origin.`); marker = new Marker({ element }).setLngLat([p.longitude, p.latitude]).addTo(map); markers.current.set(p.id, marker); } else marker.setLngLat([p.longitude, p.latitude]); });
}

export default function MapLibreCanvas({ participants, stationAreas, resultState, selectedStationAreaId = null, onStationAreaSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null); const mapRef = useRef<Map | null>(null); const markersRef = useRef(new globalThis.Map<string, Marker>()); const inputs = useRef({ onStationAreaSelect }); const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading"); const [markersReady, setMarkersReady] = useState(false); const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL; const attribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION; const stations = useMemo(() => stationData(stationAreas), [stationAreas]); const [territoryFeatureCount, setTerritoryFeatureCount] = useState(0); const [tooltip, setTooltip] = useState<{ name: string; stationAreaId: string; x: number; y: number } | null>(null); const tooltipRef = useRef<HTMLDivElement>(null);
  useEffect(() => { inputs.current = { onStationAreaSelect }; }, [onStationAreaSelect]);
  useLayoutEffect(() => { const el = tooltipRef.current; const frame = containerRef.current; if (!el || !tooltip || !frame) return; const offset = 14; const gap = 10; const maxLeft = Math.max(frame.clientWidth - el.offsetWidth - gap, gap); const maxTop = Math.max(frame.clientHeight - el.offsetHeight - gap, gap); el.style.left = `${Math.min(Math.max(tooltip.x + offset, gap), maxLeft)}px`; el.style.top = `${Math.min(Math.max(tooltip.y + offset, gap), maxTop)}px`; }, [tooltip]);
  useEffect(() => {
    if (!containerRef.current) { setState("unavailable"); return; }
    let active = true; let map: Map | null = null; let resizeObserver: ResizeObserver | null = null; const fail = () => { if (active) setState("unavailable"); };
    try {
      map = new Map({ container: containerRef.current, style: styleUrl, center: MUNICH_CENTER, zoom: 11, attributionControl: false }); mapRef.current = map;
      if (process.env.NODE_ENV !== "production") (window as unknown as { __meeetMap?: Map }).__meeetMap = map;
      resizeObserver = new ResizeObserver(() => map?.resize()); resizeObserver.observe(containerRef.current); map.addControl(new AttributionControl({ compact: true, customAttribution: attribution }), "bottom-right"); map.addControl(new NavigationControl({ showCompass: false }), "top-right"); map.on("error", fail);
      map.once("style.load", () => {
        if (!map || !active) return; if (!(map.getStyle().layers?.some((layer) => layer.type !== "background") ?? false)) { fail(); return; }
        map.addSource("meeet-territories", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        (["red", "blue", "fair"] as const).forEach((classification) => map!.addLayer({ id: `meeet-territory-${classification}`, type: "fill", source: "meeet-territories", filter: ["==", ["get", "classification"], classification], paint: { "fill-color": STATION_COLORS[classification], "fill-opacity": TERRITORY_FILL_OPACITY } }));
        map.addSource("meeet-station-areas", { type: "geojson", data: stationData([]) });
        (["red", "blue", "fair", "unclassified"] as const).forEach((classification) => { map!.addImage(`meeet-station-diamond-${classification}`, stationDiamondImage(STATION_COLORS[classification]), { pixelRatio: 2 }); map!.addLayer({ id: `meeet-stations-${classification}`, type: "symbol", source: "meeet-station-areas", filter: ["==", ["get", "classification"], classification], layout: { "icon-image": `meeet-station-diamond-${classification}`, "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "center" } }); });
        map.addImage("meeet-selected-station-diamond", selectedStationOutlineImage(), { pixelRatio: 2 }); map.addLayer({ id: "meeet-selected-station-area", type: "symbol", source: "meeet-station-areas", filter: ["==", ["id"], ""], layout: { "icon-image": "meeet-selected-station-diamond", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "center" } });
        const select = (event: MapLayerMouseEvent) => { const id = event.features?.[0]?.properties?.stationAreaId; if (typeof id === "string" && id.trim() !== "") inputs.current.onStationAreaSelect?.(id); }; const hover = (event: MapLayerMouseEvent) => { const props = event.features?.[0]?.properties; if (typeof props?.name !== "string" || typeof props.stationAreaId !== "string") { setTooltip(null); return; } setTooltip({ name: props.name, stationAreaId: props.stationAreaId, x: event.point.x, y: event.point.y }); }; const hideTooltip = () => setTooltip(null);
        map.on("click", STATION_LAYERS, select); map.on("mouseout", hideTooltip); STATION_LAYERS.forEach((layer) => { map!.on("mouseenter", layer, () => { map!.getCanvas().style.cursor = "pointer"; }); map!.on("mouseleave", layer, () => { map!.getCanvas().style.cursor = ""; }); map!.on("mouseenter", layer, hover); map!.on("mousemove", layer, hover); map!.on("mouseleave", layer, hideTooltip); }); setState("ready");
      });
    } catch { fail(); }
    return () => { active = false; setTooltip(null); resizeObserver?.disconnect(); markersRef.current.forEach((marker) => marker.remove()); markersRef.current.clear(); map?.remove(); if (process.env.NODE_ENV !== "production" && (window as unknown as { __meeetMap?: Map }).__meeetMap === map) delete (window as unknown as { __meeetMap?: Map }).__meeetMap; mapRef.current = null; };
  }, [attribution, styleUrl]);
  useEffect(() => { const map = mapRef.current; if (!map || state !== "ready") return; setTooltip(null); setMarkersReady(false); const territorySource = map.getSource("meeet-territories") as GeoJSONSource | undefined; const stationSource = map.getSource("meeet-station-areas") as GeoJSONSource | undefined; territorySource?.setData({ type: "FeatureCollection", features: [] }); stationSource?.setData(stations); const generated = territoryData(stationAreas, resultState); territorySource?.setData(generated); setTerritoryFeatureCount(generated.features.length); syncOrigins(map, participants, markersRef); const markReady = () => { if (!map || map !== mapRef.current) return; const ready = stationAreas.length === 0 || stationAreas.every((area) => map.queryRenderedFeatures(map.project([area.coordinate.longitude, area.coordinate.latitude]), { layers: STATION_LAYERS }).some((feature) => feature.properties?.stationAreaId === area.stationAreaId)); if (ready) setMarkersReady(true); }; map.once("idle", markReady); return () => { map.off("idle", markReady); }; }, [stationAreas, stations, participants, state, resultState]);
  useEffect(() => { const map = mapRef.current; if (!map || state !== "ready") return; map.setFilter("meeet-selected-station-area", ["==", ["id"], selectedStationAreaId ?? ""]); }, [selectedStationAreaId, state]);
  const label = resultState === "ok" ? `Munich meeting territory map with ${stationAreas.length} calculated station-area markers; unclassified territories are unfilled and gray diamonds are unclassified station areas` : resultState === "no-result" ? `Munich meeting territory map with ${stationAreas.length} unclassified station-area markers; unclassified territories are unfilled and gray diamonds are unclassified station areas` : "Munich meeting map with two participant origins; unclassified territories are unfilled and gray diamonds are unclassified station areas";
  return <section className="map-frame" aria-label={label} data-map-state={state} data-map-style="configured" data-station-area-count={stationAreas.length} data-station-marker-count={stationAreas.length} data-station-markers-ready={markersReady ? "true" : "false"} data-territory-source="shared" data-territory-fill-layers="3" data-territory-fill-opacity={TERRITORY_FILL_OPACITY} data-territory-feature-count={territoryFeatureCount}><h2 className="sr-only">Munich meeting map</h2><div ref={containerRef} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />{state === "loading" && <div className="map-message" role="status">Loading Munich map…</div>}{state === "unavailable" && <div className="map-message" role="status"><strong>Map unavailable</strong><span>The station-area territory map is unavailable; unclassified territories are unfilled. The planned route calculation is still separate.</span></div>}{tooltip && state === "ready" && stationAreas.some((area) => area.stationAreaId === tooltip.stationAreaId) && <div ref={tooltipRef} data-station-tooltip className="map-tooltip">{tooltip.name}</div>}</section>;
}
