"use client";

import { useEffect, useRef, useState } from "react";
import { AttributionControl, Map, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MeetingCorridor } from "@/lib/domain/types";
import type { RouteFirstMapEvidence } from "@/lib/client/route-first-map-evidence";
import { routeFirstLineData, routeFirstPointData } from "./route-first-map-data";

export type MapParticipant = { id: string; number: number; label: string; mode: string; latitude: number; longitude: number; color: string };
export type MapPoi = { id: string; number: number; name: string; category: string; address?: string; coordinates: [number, number] };
export type MapResultState = "initial" | "no-candidate" | "ok";
export type MapRouteLeg = { participantId: string; color: string; geometry: { type: "LineString"; coordinates: [number, number][] } | null };
type Props = { corridor?: MeetingCorridor; participants: readonly MapParticipant[]; pois: readonly MapPoi[]; routeLegs?: readonly MapRouteLeg[]; routeFirstEvidence?: RouteFirstMapEvidence | null; selectedPoiId: string | null; onPoiSelect: (id: string) => void; resultState: MapResultState };
type MapState = "loading" | "ready" | "unavailable";
type PointFeature = { type: "Feature"; id: string; properties: Record<string, string | number>; geometry: { type: "Point"; coordinates: [number, number] } };
type PointCollection = { type: "FeatureCollection"; features: PointFeature[] };
type RouteCollection = { type: "FeatureCollection"; features: Array<{ type: "Feature"; id: string; properties: Record<string, string>; geometry: { type: "LineString"; coordinates: [number, number][] } }> };
const MUNICH_CENTER: [number, number] = [11.576, 48.137];
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const MAP_WORKER_URL = "/vendor/maplibre-gl/maplibre-gl-worker.mjs";
type MapLibreErrorDetails = { message?: unknown; status?: unknown; url?: unknown };

setWorkerUrl(MAP_WORKER_URL);

function participantData(items: readonly MapParticipant[]): PointCollection { return { type: "FeatureCollection", features: items.map((p) => ({ type: "Feature", id: p.id, properties: { id: p.id, number: p.number, label: p.label, mode: p.mode, color: p.color }, geometry: { type: "Point", coordinates: [p.longitude, p.latitude] } })) }; }
function poiData(items: readonly MapPoi[]): PointCollection { return { type: "FeatureCollection", features: items.map((p) => ({ type: "Feature", id: p.id, properties: { id: p.id, number: p.number, name: p.name, category: p.category }, geometry: { type: "Point", coordinates: p.coordinates } })) }; }
function routeData(items: readonly MapRouteLeg[]): RouteCollection { return { type: "FeatureCollection", features: items.flatMap((leg) => leg.geometry ? [{ type: "Feature", id: leg.participantId, properties: { participantId: leg.participantId, color: leg.color }, geometry: leg.geometry }] : []) }; }
function safeResourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value, "http://meeet.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}[redacted]`;
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return "[redacted-url]";
  }
}
function safeMapErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "Unknown MapLibre error";
  return value.replace(/https?:\/\/[^\s]+/gi, (url) => safeResourceUrl(url) ?? "[redacted-url]").slice(0, 512);
}
function logMapLibreError(event: { error: MapLibreErrorDetails }): void {
  const error = event.error;
  const status = typeof error.status === "number" && Number.isFinite(error.status)
    ? error.status
    : typeof error.status === "string"
      ? error.status.slice(0, 32)
      : undefined;
  console.warn("[meeet] MapLibre resource error", {
    url: safeResourceUrl(error.url),
    status,
    message: safeMapErrorMessage(error.message),
  });
}

function mapAriaLabel(corridor: MeetingCorridor | undefined, resultState: MapResultState): string {
  if (!corridor && resultState === "no-candidate") return "Interactive Munich map showing participant starting points; no comparable meeting area was found";
  if (!corridor) return "Interactive Munich map showing participant starting points; calculate a meeting area to see results";
  if (corridor.properties.kind === "sample-grid-corridor") {
    return "Interactive Munich map showing participants, sample-grid meeting cells, and food and drink venues";
  }
  return "Interactive Munich map showing participants, routed candidate centers, and limited nearby-venue search buffers";
}

export default function MapLibreCanvas({ corridor, participants, pois, routeLegs = [], routeFirstEvidence = null, selectedPoiId, onPoiSelect, resultState }: Props) {
  const containerRef = useRef<HTMLDivElement>(null); const mapRef = useRef<Map | null>(null); const loadedRef = useRef(false);
  const inputsRef = useRef({ corridor, participants, pois, routeLegs, routeFirstEvidence, onPoiSelect }); const [state, setState] = useState<MapState>("loading");
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL; const customAttribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION;
  useEffect(() => { inputsRef.current = { corridor, participants, pois, routeLegs, routeFirstEvidence, onPoiSelect }; }, [corridor, participants, pois, routeLegs, routeFirstEvidence, onPoiSelect]);

  useEffect(() => {
    if (!containerRef.current) { setState("unavailable"); return; }
    const mapContainer = containerRef.current;
    let map!: Map;
    let constructed = false;
    let active = true;
    let failed = false;
    let initialized = false;
    let initializationTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeFrame: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const clearInitializationTimer = () => {
      if (initializationTimer) clearTimeout(initializationTimer);
      initializationTimer = undefined;
    };
    const stopResizeObservation = () => {
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      if (resizeFrame !== undefined) {
        if (typeof window !== "undefined") window.cancelAnimationFrame(resizeFrame);
        resizeFrame = undefined;
      }
    };
    const resizeMap = () => {
      resizeFrame = undefined;
      if (!active || failed || !constructed || mapRef.current !== map) return;
      try { map.resize(); } catch { fail(); }
    };
    const scheduleResize = () => {
      if (!active || failed || !constructed || resizeFrame !== undefined || typeof window === "undefined") return;
      resizeFrame = window.requestAnimationFrame(resizeMap);
    };
    const fail = () => {
      if (!active || failed) return;
      failed = true;
      loadedRef.current = false;
      active = false;
      clearInitializationTimer();
      stopResizeObservation();
      if (constructed) {
        map.off("style.load", onStyleLoad);
        map.off("load", onMapLoad);
        map.off("error", onMapError);
        map.remove();
        constructed = false;
      }
      if (mapRef.current === map) mapRef.current = null;
      containerRef.current?.replaceChildren();
      setState("unavailable");
    };
    const onMapError = (event: { error: MapLibreErrorDetails }) => {
      if (active) logMapLibreError(event);
    };
    const onStyleLoad = () => {
      if (!active || failed || initialized) return;
      try {
        const current = inputsRef.current;
        map.addSource("meeet-corridor", { type: "geojson", data: current.corridor ?? { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "meeet-corridor-fill", type: "fill", source: "meeet-corridor", paint: { "fill-color": "#ef785e", "fill-opacity": 0.2 } });
        map.addLayer({ id: "meeet-corridor-line", type: "line", source: "meeet-corridor", paint: { "line-color": "#a64e39", "line-width": 2, "line-dasharray": [2, 2] } });
        map.addSource("meeet-routes", { type: "geojson", data: routeData(current.routeLegs) });
        map.addLayer({ id: "meeet-route-lines", type: "line", source: "meeet-routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.88 } });
        map.addSource("meeet-route-first-lines", { type: "geojson", data: routeFirstLineData(current.routeFirstEvidence) });
        map.addLayer({ id: "meeet-route-first-lines", type: "line", source: "meeet-route-first-lines", filter: ["!=", ["get", "kind"], "alternate-route"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#7654a5", "line-width": 3, "line-opacity": 0.82 } });
        map.addLayer({ id: "meeet-route-first-corridors", type: "line", source: "meeet-route-first-lines", filter: ["==", ["get", "kind"], "corridor"], paint: { "line-color": "#d8644e", "line-width": 5, "line-dasharray": [2, 2], "line-opacity": 0.88 } });
        map.addLayer({ id: "meeet-route-first-fair-regions", type: "line", source: "meeet-route-first-lines", filter: ["==", ["get", "kind"], "fair-region"], paint: { "line-color": "#165b47", "line-width": 7, "line-opacity": 0.9 } });
        map.addLayer({ id: "meeet-route-first-alternates", type: "line", source: "meeet-route-first-lines", filter: ["==", ["get", "kind"], "alternate-route"], paint: { "line-color": "#7654a5", "line-width": 3, "line-dasharray": [1, 2], "line-opacity": 0.72 } });
        map.addSource("meeet-route-first-points", { type: "geojson", data: routeFirstPointData(current.routeFirstEvidence) });
        map.addLayer({ id: "meeet-route-first-points", type: "circle", source: "meeet-route-first-points", paint: { "circle-color": ["match", ["get", "kind"], "target", "#f5d873", "midpoint", "#fffdf8", "landmark", "#d8644e", "#202522"], "circle-radius": ["match", ["get", "kind"], "landmark", 9, 7], "circle-stroke-color": "#202522", "circle-stroke-width": 2 } });
        map.addSource("meeet-participants", { type: "geojson", data: participantData(current.participants) });
        map.addLayer({ id: "meeet-participant-points", type: "circle", source: "meeet-participants", paint: { "circle-color": ["get", "color"], "circle-radius": 10, "circle-stroke-color": "#fffdf8", "circle-stroke-width": 3 } });
        map.addLayer({ id: "meeet-participant-labels", type: "symbol", source: "meeet-participants", layout: { "text-field": ["concat", ["get", "number"], " · ", ["get", "mode"]], "text-size": 11, "text-offset": [0, 2], "text-anchor": "top" }, paint: { "text-color": "#202522", "text-halo-color": "#fffdf8", "text-halo-width": 2 } });
        map.addSource("meeet-pois", { type: "geojson", data: poiData(current.pois) });
        map.addLayer({ id: "meeet-poi-points", type: "circle", source: "meeet-pois", paint: { "circle-color": "#f5d873", "circle-radius": 8, "circle-stroke-color": "#202522", "circle-stroke-width": 1.5 } });
        map.addLayer({ id: "meeet-poi-selected", type: "circle", source: "meeet-pois", filter: ["==", ["get", "id"], ""], paint: { "circle-color": "#fffdf8", "circle-radius": 13, "circle-stroke-color": "#a64e39", "circle-stroke-width": 3 } });
        map.addLayer({ id: "meeet-poi-labels", type: "symbol", source: "meeet-pois", layout: { "text-field": ["get", "number"], "text-size": 10 }, paint: { "text-color": "#202522" } });
        map.on("click", "meeet-poi-points", (event) => { if (!active) return; const id = event.features?.[0]?.properties?.id; if (typeof id === "string") inputsRef.current.onPoiSelect(id); });
        map.on("mouseenter", "meeet-poi-points", () => { if (active) map.getCanvas().style.cursor = "pointer"; }); map.on("mouseleave", "meeet-poi-points", () => { if (active) map.getCanvas().style.cursor = ""; });
        initialized = true;
      } catch { fail(); }
    };
    const onMapLoad = () => {
      if (!active || failed || !initialized) return;
      clearInitializationTimer();
      loadedRef.current = true;
      setState("ready");
      scheduleResize();
    };
    try {
      map = new Map({ container: mapContainer, style: styleUrl, center: MUNICH_CENTER, zoom: 11, attributionControl: false });
      constructed = true;
      mapRef.current = map;
      map.addControl(new AttributionControl({ compact: true, customAttribution }), "bottom-right");
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      initializationTimer = setTimeout(fail, 12000);
      map.once("style.load", onStyleLoad);
      map.on("load", onMapLoad);
      map.on("error", onMapError);
      if (typeof ResizeObserver !== "undefined") {
        try {
          resizeObserver = new ResizeObserver(scheduleResize);
          resizeObserver.observe(mapContainer);
        } catch { resizeObserver = undefined; }
      }
      scheduleResize();
    } catch { queueMicrotask(fail); }
    return () => {
      active = false;
      failed = true;
      loadedRef.current = false;
      clearInitializationTimer();
      stopResizeObservation();
      if (constructed) {
        map.off("style.load", onStyleLoad);
        map.off("load", onMapLoad);
        map.off("error", onMapError);
        map.remove();
        constructed = false;
      }
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [styleUrl, customAttribution]);

  useEffect(() => { const map = mapRef.current; if (!map || !loadedRef.current) return; const routeFirstActive = Boolean(routeFirstEvidence); const corridorSource = map.getSource("meeet-corridor") as GeoJSONSource | undefined; const routeSource = map.getSource("meeet-routes") as GeoJSONSource | undefined; const participantsSource = map.getSource("meeet-participants") as GeoJSONSource | undefined; const poisSource = map.getSource("meeet-pois") as GeoJSONSource | undefined; const routeFirstLineSource = map.getSource("meeet-route-first-lines") as GeoJSONSource | undefined; const routeFirstPointSource = map.getSource("meeet-route-first-points") as GeoJSONSource | undefined; corridorSource?.setData(routeFirstActive ? { type: "FeatureCollection", features: [] } : corridor ?? { type: "FeatureCollection", features: [] }); routeSource?.setData(routeFirstActive ? routeData([]) : routeData(routeLegs)); participantsSource?.setData(participantData(participants)); poisSource?.setData(routeFirstActive ? poiData([]) : poiData(pois)); routeFirstLineSource?.setData(routeFirstLineData(routeFirstEvidence)); routeFirstPointSource?.setData(routeFirstPointData(routeFirstEvidence)); if (map.getLayer("meeet-poi-selected")) map.setFilter("meeet-poi-selected", ["==", ["get", "id"], routeFirstActive ? "" : selectedPoiId ?? ""]); }, [corridor, participants, pois, routeLegs, routeFirstEvidence, selectedPoiId, state]);
  return <section className="relative h-full min-h-[430px] overflow-hidden rounded-[1.75rem] border border-[#cbd7cd] bg-[#dce9df] shadow-[0_18px_50px_rgba(52,74,59,.13)]" aria-labelledby="map-title" data-map-state={state}><h2 id="map-title" className="sr-only">Munich meeting area map</h2><div ref={containerRef} className="!absolute inset-0" aria-label={routeFirstEvidence ? "Interactive Munich map showing participant origins, selected-family certified routes, exact directional corridors, fair-region segments, and certified midpoint evidence" : mapAriaLabel(corridor, resultState)} />{state === "loading" && <div className="absolute inset-0 grid place-items-center bg-[#dce9df] text-sm text-[#526057]" role="status">Loading Munich map…</div>}{state === "unavailable" && <div className="absolute inset-0 grid place-items-center bg-[#dce9df] p-6 text-center"><div className="max-w-sm rounded-2xl border border-[#cbd7cd] bg-[#fffdf8]/95 p-5 shadow-lg" role="status"><p className="font-semibold text-[#202522]">Map unavailable</p><p className="mt-2 text-sm leading-5 text-[#526057]">The configured map style could not be loaded. The setup and accessible venue list remain available.</p></div></div>}</section>;
}
