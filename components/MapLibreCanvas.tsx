"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { AttributionControl, Map, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FairLocation } from "@/lib/client/meeting-response";

export type MapParticipant = { id: string; number: number; label: string; latitude: number; longitude: number; color: string };
export type ParticipantMapCoordinate = { latitude: number; longitude: number };
export type MapResultState = "initial" | "ok";
type PointFeature = { type: "Feature"; id: string; properties: Record<string, string | number>; geometry: { type: "Point"; coordinates: [number, number] } };
type PointCollection = { type: "FeatureCollection"; features: PointFeature[] };
type RouteGeometry = { type: "LineString"; coordinates: [number, number][] };
type FocusedJourney = { participantId: string; geometries: readonly RouteGeometry[] } | null;
type RouteFeature = { type: "Feature"; id: string; properties: { color: string }; geometry: RouteGeometry };
type RouteCollection = { type: "FeatureCollection"; features: RouteFeature[] };
type Props = { participants: readonly MapParticipant[]; fairLocations: readonly FairLocation[]; selectedLocationId: string | null; focusedJourney: FocusedJourney; onLocationSelect: (id: string) => void; onParticipantMove: (participantId: string, coordinate: ParticipantMapCoordinate) => void; resultState: MapResultState };

const MUNICH_CENTER: [number, number] = [11.576, 48.137];
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const MAP_WORKER_URL = "/vendor/maplibre-gl/maplibre-gl-worker.mjs";
setWorkerUrl(MAP_WORKER_URL);

function participantData(items: readonly MapParticipant[]): PointCollection {
  return { type: "FeatureCollection", features: items.map((p) => ({ type: "Feature", id: p.id, properties: { id: p.id, number: p.number, label: p.label, color: p.color }, geometry: { type: "Point", coordinates: [p.longitude, p.latitude] } })) };
}
function locationData(items: readonly FairLocation[]): PointCollection {
  return { type: "FeatureCollection", features: items.map((p, index) => ({ type: "Feature", id: p.id, properties: { id: p.id, number: index + 1, kind: p.kind }, geometry: { type: "Point", coordinates: [p.coordinate.longitude, p.coordinate.latitude] } })) };
}
function focusedJourneyData(journey: FocusedJourney, color: string): RouteCollection {
  return { type: "FeatureCollection", features: journey?.geometries.map((geometry, index) => ({ type: "Feature", id: `meeet-route-part-${index}`, properties: { color }, geometry })) ?? [] };
}

function syncParticipantMarkers(map: Map, participants: readonly MapParticipant[], markersRef: MutableRefObject<globalThis.Map<string, Marker>>, inputs: MutableRefObject<{ participants: readonly MapParticipant[]; fairLocations: readonly FairLocation[]; onLocationSelect: (id: string) => void; onParticipantMove: (participantId: string, coordinate: ParticipantMapCoordinate) => void }>) {
  const ids = new Set(participants.map((participant) => participant.id));
  markersRef.current.forEach((marker, id) => { if (!ids.has(id)) { marker.remove(); markersRef.current.delete(id); } });
  participants.forEach((participant) => {
    let marker = markersRef.current.get(participant.id);
    if (!marker) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "meeet-origin-marker";
      element.dataset.originId = participant.id;
      element.style.backgroundColor = participant.color;
      element.textContent = String(participant.number);
      element.setAttribute("aria-label", `Participant ${participant.number} origin. Drag to adjust.`);
      element.title = "Drag to adjust this origin";
      marker = new Marker({ element, color: participant.color, draggable: true }).setLngLat([participant.longitude, participant.latitude]).addTo(map);
      marker.on("dragend", () => { const lngLat = marker!.getLngLat(); inputs.current.onParticipantMove(participant.id, { latitude: lngLat.lat, longitude: lngLat.lng }); });
      markersRef.current.set(participant.id, marker);
    } else marker.setLngLat([participant.longitude, participant.latitude]);
  });
}

export default function MapLibreCanvas({ participants, fairLocations, selectedLocationId, focusedJourney, onLocationSelect, onParticipantMove, resultState }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const loadedRef = useRef(false);
  const participantMarkersRef = useRef(new globalThis.Map<string, Marker>());
  const inputsRef = useRef({ participants, fairLocations, onLocationSelect, onParticipantMove });
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL;
  const customAttribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION;
  useEffect(() => { inputsRef.current = { participants, fairLocations, onLocationSelect, onParticipantMove }; }, [participants, fairLocations, onLocationSelect, onParticipantMove]);

  useEffect(() => {
    if (!containerRef.current) { setState("unavailable"); return; }
    const element = containerRef.current;
    let map: Map | null = null;
    let active = true;
    try {
      map = new Map({ container: element, style: styleUrl, center: MUNICH_CENTER, zoom: 11, attributionControl: false });
      mapRef.current = map;
      map.addControl(new AttributionControl({ compact: true, customAttribution }), "bottom-right");
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("error", () => { if (active && !loadedRef.current) setState("unavailable"); });
      map.once("style.load", () => {
        if (!map || !active) return;
        map.addSource("meeet-participants", { type: "geojson", data: participantData(inputsRef.current.participants) });
        syncParticipantMarkers(map, inputsRef.current.participants, participantMarkersRef, inputsRef);
         map.addSource("meeet-focused-journey", { type: "geojson", data: focusedJourneyData(null, "#276e66") });
         map.addLayer({ id: "meeet-focused-journey-line", type: "line", source: "meeet-focused-journey", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.9 } });
        map.addSource("meeet-fair-locations", { type: "geojson", data: locationData(inputsRef.current.fairLocations) });
        map.addLayer({ id: "meeet-fair-location-points", type: "circle", source: "meeet-fair-locations", paint: { "circle-color": "#f5d873", "circle-radius": 9, "circle-stroke-color": "#202522", "circle-stroke-width": 2 } });
        map.addLayer({ id: "meeet-fair-location-selected", type: "circle", source: "meeet-fair-locations", filter: ["==", ["get", "id"], ""], paint: { "circle-color": "#fffdf8", "circle-radius": 13, "circle-stroke-color": "#a64e39", "circle-stroke-width": 3 } });
        map.addLayer({ id: "meeet-fair-location-labels", type: "symbol", source: "meeet-fair-locations", layout: { "text-field": ["get", "number"], "text-size": 10 }, paint: { "text-color": "#202522" } });
        map.on("click", "meeet-fair-location-points", (event) => { const id = event.features?.[0]?.properties?.id; if (active && typeof id === "string") inputsRef.current.onLocationSelect(id); });
        map.on("mouseenter", "meeet-fair-location-points", () => { if (map) map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "meeet-fair-location-points", () => { if (map) map.getCanvas().style.cursor = ""; });
      });
      map.on("load", () => { if (active) { loadedRef.current = true; setState("ready"); } });
    } catch { queueMicrotask(() => setState("unavailable")); }
    return () => { active = false; loadedRef.current = false; participantMarkersRef.current.forEach((marker) => marker.remove()); participantMarkersRef.current.clear(); map?.remove(); mapRef.current = null; };
  }, [styleUrl, customAttribution]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource("meeet-participants") as GeoJSONSource | undefined)?.setData(participantData(participants));
    syncParticipantMarkers(map, participants, participantMarkersRef, inputsRef);
    (map.getSource("meeet-fair-locations") as GeoJSONSource | undefined)?.setData(locationData(fairLocations));
    const focusedColor = participants.find((participant) => participant.id === focusedJourney?.participantId)?.color ?? "#276e66";
    (map.getSource("meeet-focused-journey") as GeoJSONSource | undefined)?.setData(focusedJourneyData(focusedJourney, focusedColor));
    if (map.getLayer("meeet-fair-location-selected")) map.setFilter("meeet-fair-location-selected", ["==", ["get", "id"], selectedLocationId ?? ""]);
  }, [participants, fairLocations, selectedLocationId, focusedJourney, state]);

  const label = resultState === "ok" ? "Interactive Munich map showing two participant origins and sampled station locations" : "Interactive Munich map showing two Munich participant origins";
  return <section className="relative h-full min-h-[430px] overflow-hidden rounded-[1.75rem] border border-[#cbd7cd] bg-[#dce9df] shadow-[0_18px_50px_rgba(52,74,59,.13)]" aria-label={label} data-map-state={state} data-focused-journey-parts={focusedJourney?.geometries.length ?? 0}>
    <h2 id="map-title" className="sr-only">Munich meeting map</h2><div ref={containerRef} className="!absolute inset-0" aria-label={label} />
    {fairLocations.length > 0 && <div className="sr-only" aria-label="Sampled station markers">{fairLocations.map((location, index) => <button key={location.id} type="button" aria-label={`Sampled station ${index + 1}: ${location.physicalIdentity}`} onClick={() => { onLocationSelect(location.id); window.setTimeout(() => document.getElementById(`fair-location-${location.id}`)?.focus({ preventScroll: false }), 50); }}>Fair location {index + 1}</button>)}</div>}
    {state === "loading" && <div className="absolute inset-0 grid place-items-center bg-[#dce9df] text-sm text-[#526057]" role="status">Loading Munich map…</div>}
    {state === "unavailable" && <div className="absolute inset-0 grid place-items-center bg-[#dce9df] p-6 text-center"><div className="max-w-sm rounded-2xl border border-[#cbd7cd] bg-[#fffdf8]/95 p-5 shadow-lg" role="status"><p className="font-semibold text-[#202522]">Map unavailable</p><p className="mt-2 text-sm leading-5 text-[#526057]">The map could not be loaded. Your sampled station list remains available below.</p></div></div>}
  </section>;
}
