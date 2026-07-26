"use client";

import { useEffect, useRef, useState } from "react";
import { AttributionControl, Map, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MeetingCorridor } from "@/lib/domain/types";

export type MapParticipant = { id: string; number: number; label: string; mode: string; latitude: number; longitude: number; color: string };
export type MapPoi = { id: string; number: number; name: string; category: string; address?: string; coordinates: [number, number] };
type Props = { corridor?: MeetingCorridor; participants: readonly MapParticipant[]; pois: readonly MapPoi[]; selectedPoiId: string | null; onPoiSelect: (id: string) => void };
type MapState = "loading" | "ready" | "unavailable";
type PointFeature = { type: "Feature"; id: string; properties: Record<string, string | number>; geometry: { type: "Point"; coordinates: [number, number] } };
type PointCollection = { type: "FeatureCollection"; features: PointFeature[] };
const MUNICH_CENTER: [number, number] = [11.576, 48.137];
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
type MapLibreErrorDetails = { message?: unknown; status?: unknown; url?: unknown };

function participantData(items: readonly MapParticipant[]): PointCollection { return { type: "FeatureCollection", features: items.map((p) => ({ type: "Feature", id: p.id, properties: { id: p.id, number: p.number, label: p.label, mode: p.mode, color: p.color }, geometry: { type: "Point", coordinates: [p.longitude, p.latitude] } })) }; }
function poiData(items: readonly MapPoi[]): PointCollection { return { type: "FeatureCollection", features: items.map((p) => ({ type: "Feature", id: p.id, properties: { id: p.id, number: p.number, name: p.name, category: p.category }, geometry: { type: "Point", coordinates: p.coordinates } })) }; }
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

export default function MapLibreCanvas({ corridor, participants, pois, selectedPoiId, onPoiSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null); const mapRef = useRef<Map | null>(null); const loadedRef = useRef(false);
  const inputsRef = useRef({ corridor, participants, pois, onPoiSelect }); const [state, setState] = useState<MapState>("loading");
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL; const customAttribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION;
  useEffect(() => { inputsRef.current = { corridor, participants, pois, onPoiSelect }; }, [corridor, participants, pois, onPoiSelect]);

  useEffect(() => {
    if (!containerRef.current) { setState("unavailable"); return; }
    let map!: Map;
    let constructed = false;
    let active = true;
    let failed = false;
    let initialized = false;
    let initializationTimer: ReturnType<typeof setTimeout> | undefined;
    const clearInitializationTimer = () => {
      if (initializationTimer) clearTimeout(initializationTimer);
      initializationTimer = undefined;
    };
    const fail = () => {
      if (!active || failed) return;
      failed = true;
      loadedRef.current = false;
      active = false;
      clearInitializationTimer();
      if (constructed) {
        map.off("style.load", onStyleLoad);
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
      clearInitializationTimer();
      try {
        const current = inputsRef.current;
        map.addSource("meeet-corridor", { type: "geojson", data: current.corridor ?? { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "meeet-corridor-fill", type: "fill", source: "meeet-corridor", paint: { "fill-color": "#ef785e", "fill-opacity": 0.2 } });
        map.addLayer({ id: "meeet-corridor-line", type: "line", source: "meeet-corridor", paint: { "line-color": "#a64e39", "line-width": 2, "line-dasharray": [2, 2] } });
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
        loadedRef.current = true;
        setState("ready");
      } catch { fail(); }
    };
    try {
      map = new Map({ container: containerRef.current, style: styleUrl, center: MUNICH_CENTER, zoom: 11, attributionControl: false });
      constructed = true;
      mapRef.current = map;
      map.addControl(new AttributionControl({ compact: true, customAttribution }), "bottom-right");
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      initializationTimer = setTimeout(fail, 12000);
      map.once("style.load", onStyleLoad);
      map.on("error", onMapError);
    } catch { queueMicrotask(fail); }
    return () => {
      active = false;
      failed = true;
      loadedRef.current = false;
      clearInitializationTimer();
      if (constructed) {
        map.off("style.load", onStyleLoad);
        map.off("error", onMapError);
        map.remove();
        constructed = false;
      }
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [styleUrl, customAttribution]);

  useEffect(() => { const map = mapRef.current; if (!map || !loadedRef.current) return; const corridorSource = map.getSource("meeet-corridor") as GeoJSONSource | undefined; const participantsSource = map.getSource("meeet-participants") as GeoJSONSource | undefined; const poisSource = map.getSource("meeet-pois") as GeoJSONSource | undefined; corridorSource?.setData(corridor ?? { type: "FeatureCollection", features: [] }); participantsSource?.setData(participantData(participants)); poisSource?.setData(poiData(pois)); if (map.getLayer("meeet-poi-selected")) map.setFilter("meeet-poi-selected", ["==", ["get", "id"], selectedPoiId ?? ""]); }, [corridor, participants, pois, selectedPoiId, state]);
  return <section className="relative h-full min-h-[430px] overflow-hidden rounded-[1.75rem] border border-[#cbd7cd] bg-[#dce9df] shadow-[0_18px_50px_rgba(52,74,59,.13)]" aria-labelledby="map-title"><h2 id="map-title" className="sr-only">Munich meeting area map</h2><div ref={containerRef} className="absolute inset-0" aria-label="Interactive Munich map showing the equal-time corridor, participants, and food and drink venues" />{state === "loading" && <div className="absolute inset-0 grid place-items-center bg-[#dce9df] text-sm text-[#526057]" role="status">Loading Munich map…</div>}{state === "unavailable" && <div className="absolute inset-0 grid place-items-center bg-[#dce9df] p-6 text-center"><div className="max-w-sm rounded-2xl border border-[#cbd7cd] bg-[#fffdf8]/95 p-5 shadow-lg" role="status"><p className="font-semibold text-[#202522]">Map unavailable</p><p className="mt-2 text-sm leading-5 text-[#526057]">The configured map style could not be loaded. The setup and accessible venue list remain available.</p></div></div>}</section>;
}
