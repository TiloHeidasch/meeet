"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { AttributionControl, Map, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MeetingStationArea, StationAreaMode } from "@/lib/client/meeting-response";
import { buildStationTerritories, type StationTerritory } from "@/lib/client/station-territories";
import { STATION_ICON_PADDING, STATION_ICON_VISUAL_SIZES } from "@/lib/client/station-icon-sizes";

export type MapParticipant = { id: string; number: number; label: string; latitude: number; longitude: number; color: "#e85d4a" | "#3d70c9" };
type Props = { participants: readonly MapParticipant[]; stationAreas: readonly MeetingStationArea[]; resultState: "initial" | "ok" | "no-result"; selectedStationAreaId?: string | null; onStationAreaSelect?: (stationAreaId: string) => void };
type Geometry = { type: "MultiPolygon"; coordinates: number[][][][] } | { type: "Point"; coordinates: [number, number] };
type FeatureCollection = { type: "FeatureCollection"; features: Array<{ type: "Feature"; id: string; properties: Record<string, string>; geometry: Geometry }> };
const MUNICH_CENTER: [number, number] = [11.576, 48.137];
const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const TERRITORY_FILL_OPACITY = 0.4;
/** Station icon layers in paint order, bottommost first: bus < tram < ubahn < sbahn. */
const STATION_ICON_PAINT_ORDER: readonly StationAreaMode[] = ["bus", "tram", "ubahn", "sbahn"];
const STATION_ICON_LAYERS = STATION_ICON_PAINT_ORDER.map((mode) => `meeet-stations-${mode}`);
const STATION_COLORS = { red: "#e85d4a", blue: "#3d70c9", fair: "#f0ca43", unclassified: "#65716a" } as const;
setWorkerUrl("/vendor/maplibre-gl/maplibre-gl-worker.mjs");

const S_PATH_D = "M 472 131 L 471 132 L 458 132 L 457 133 L 448 133 L 447 134 L 434 135 L 433 136 L 428 136 L 398 143 L 376 150 L 356 158 L 330 171 L 312 182 L 286 202 L 265 223 L 253 238 L 242 255 L 229 282 L 223 300 L 219 317 L 218 329 L 217 330 L 217 340 L 216 341 L 217 384 L 218 385 L 220 403 L 227 428 L 231 438 L 243 461 L 249 470 L 266 490 L 292 512 L 319 529 L 350 544 L 406 564 L 409 564 L 416 567 L 444 574 L 448 576 L 455 577 L 459 579 L 496 588 L 500 590 L 507 591 L 546 603 L 549 605 L 557 607 L 572 614 L 574 614 L 590 622 L 604 631 L 622 647 L 630 658 L 636 670 L 640 687 L 640 705 L 637 716 L 632 726 L 624 737 L 608 752 L 596 760 L 578 769 L 564 774 L 548 778 L 537 779 L 536 780 L 496 781 L 495 780 L 483 780 L 482 779 L 468 778 L 467 777 L 462 777 L 461 776 L 456 776 L 446 773 L 442 773 L 405 762 L 402 760 L 387 755 L 380 751 L 378 751 L 343 733 L 312 713 L 276 684 L 248 656 L 232 637 L 222 623 L 222 770 L 248 791 L 290 817 L 332 837 L 352 845 L 360 847 L 363 849 L 366 849 L 369 851 L 375 852 L 395 859 L 419 865 L 423 865 L 428 867 L 443 869 L 444 870 L 450 870 L 451 871 L 463 872 L 464 873 L 472 873 L 473 874 L 501 875 L 502 876 L 542 875 L 543 874 L 561 873 L 562 872 L 568 872 L 569 871 L 590 868 L 610 863 L 617 860 L 620 860 L 647 850 L 674 837 L 700 821 L 728 799 L 751 776 L 767 756 L 777 741 L 793 711 L 799 696 L 806 673 L 806 669 L 809 658 L 809 652 L 810 651 L 810 642 L 811 641 L 810 600 L 809 599 L 809 592 L 808 591 L 806 576 L 798 550 L 789 531 L 778 514 L 771 505 L 752 486 L 726 467 L 694 450 L 692 450 L 667 439 L 619 424 L 571 412 L 554 409 L 541 405 L 537 405 L 505 397 L 501 395 L 494 394 L 477 388 L 474 388 L 443 376 L 421 364 L 409 355 L 398 344 L 392 336 L 386 325 L 382 313 L 381 302 L 380 301 L 380 284 L 381 283 L 382 274 L 390 256 L 404 240 L 418 230 L 441 220 L 458 217 L 459 216 L 466 216 L 467 215 L 508 215 L 509 216 L 519 216 L 520 217 L 527 217 L 528 218 L 546 220 L 572 226 L 603 236 L 623 245 L 625 245 L 662 264 L 689 281 L 716 301 L 752 333 L 766 348 L 766 225 L 743 208 L 721 194 L 679 172 L 677 172 L 670 168 L 645 158 L 603 145 L 595 144 L 576 139 L 566 138 L 565 137 L 559 137 L 558 136 L 552 136 L 544 134 L 536 134 L 535 133 L 508 132 L 507 131 Z";
const U_PATH_D = "M418.3 39.4h-100v261.2c0 47.7-16.9 81.6-68.8 81.6-52.3 0-69.3-33.9-69.3-81.6V39.4H81.7v270.9c0 113.4 91.3 155 167.7 155 76 0 168.8-41.5 168.8-155l.1-270.9z";
const T_PATH_D = "M 75 55 H 425 V 145 H 295 V 445 H 205 V 145 H 75 Z";
const BUS_WHITE_CIRCLE_D = "m 180,0 c -99.41,0 -180,80.59 -180,180 0,99.41 80.59,180 180,180 99.41,0 180,-80.59 180,-180 0,-99.41 -80.59,-180 -180,-180 z";
const BUS_RING_D = "m 352,180 c 0,96.57 -78.79,172 -172.03,172 C 86.73,352 8,276.57 8,180 c 0,-96.57 78.73,-172 171.97,-172 93.24,0 172.03,75.43 172.03,172 z m -48,0 c 0,-68.48 -55.52,-124 -124,-124 -68.48,0 -124,55.52 -124,124 0,68.48 55.52,124 124,124 68.48,0 124,-55.52 124,-124 z";
const BUS_H_D = "m 113.26,260 c -0.7,0 -1.26,-0.56 -1.26,-1.26 l 0,-157.48 c 0,-0.7 0.56,-1.26 1.26,-1.26 l 33.48,0 c 0.7,0 1.26,0.56 1.26,1.26 l 0,60.74 64,0 0,-60.74 c 0,-0.7 0.56,-1.26 1.26,-1.26 l 33.48,0 c 0.7,0 1.26,0.56 1.26,1.26 l 0,157.48 c 0,0.7 -0.56,1.26 -1.26,1.26 l -33.48,0 c -0.7,0 -1.26,-0.56 -1.26,-1.26 l 0,-60.74 -64,0 0,60.74 c 0,0.7 -0.56,1.26 -1.26,1.26 l -33.48,0 z";
const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="28" height="28" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M3.37892 10.2236L8 16L12.6211 10.2236C13.5137 9.10788 14 7.72154 14 6.29266V6C14 2.68629 11.3137 0 8 0C4.68629 0 2 2.68629 2 6V6.29266C2 7.72154 2.4863 9.10788 3.37892 10.2236ZM8 8C9.10457 8 10 7.10457 10 6C10 4.89543 9.10457 4 8 4C6.89543 4 6 4.89543 6 6C6 7.10457 6.89543 8 8 8Z"/></svg>';

function territoryData(areas: readonly MeetingStationArea[], resultState: Props["resultState"]): FeatureCollection {
  if (resultState !== "ok" || areas.length === 0 || areas.every((area) => area.classification === "unclassified")) return { type: "FeatureCollection", features: [] };
  return { type: "FeatureCollection", features: (buildStationTerritories(areas) as readonly StationTerritory[]).filter((territory) => territory.classification !== "unclassified").map((territory) => ({ type: "Feature", id: territory.stationAreaId, properties: { classification: territory.classification }, geometry: territory.geometry as unknown as Geometry })) };
}

function stationData(areas: readonly MeetingStationArea[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: areas.map((area) => ({
      type: "Feature",
      id: area.stationAreaId,
      properties: {
        classification: area.classification,
        mode: area.mode,
        stationAreaId: area.stationAreaId,
        name: area.name,
      },
      geometry: { type: "Point", coordinates: [area.coordinate.longitude, area.coordinate.latitude] },
    })),
  };
}

/** Padded high-DPI station glyph icon rendered on a canvas. */
function stationGlyphImage(mode: StationAreaMode, color: string): ImageData {
  const pixelRatio = 2;
  const visualSize = STATION_ICON_VISUAL_SIZES[mode];
  const padding = STATION_ICON_PADDING;
  const totalSize = visualSize + padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = totalSize * pixelRatio;
  canvas.height = canvas.width;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(canvas.width, canvas.height);
  context.scale(pixelRatio, pixelRatio);

  const cx = totalSize / 2;
  const cy = totalSize / 2;
  const radius = visualSize / 2;

  if (mode === "sbahn") {
    context.save();
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = "#fffdf8";
    context.stroke();

    context.translate(padding, padding);
    context.scale(visualSize / 1000, visualSize / 1009);
    context.fillStyle = "#ffffff";
    context.fill(new Path2D(S_PATH_D));
    context.restore();
  } else if (mode === "ubahn") {
    context.save();
    context.beginPath();
    const corner = visualSize * (60 / 500);
    if (typeof context.roundRect === "function") {
      context.roundRect(padding, padding, visualSize, visualSize, corner);
    } else {
      context.rect(padding, padding, visualSize, visualSize);
    }
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = "#fffdf8";
    context.stroke();

    context.translate(padding, padding);
    context.scale(visualSize / 500, visualSize / 500);
    context.fillStyle = "#ffffff";
    context.fill(new Path2D(U_PATH_D));
    context.restore();
  } else if (mode === "tram") {
    context.save();
    context.beginPath();
    const corner = visualSize * (60 / 500);
    if (typeof context.roundRect === "function") {
      context.roundRect(padding, padding, visualSize, visualSize, corner);
    } else {
      context.rect(padding, padding, visualSize, visualSize);
    }
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = "#fffdf8";
    context.stroke();

    context.translate(padding, padding);
    context.scale(visualSize / 500, visualSize / 500);
    context.fillStyle = "#ffffff";
    context.fill(new Path2D(T_PATH_D));
    context.restore();
  } else {
    // Bus: German Haltestelle disk
    context.save();
    context.translate(padding, padding);
    context.scale(visualSize / 450, visualSize / 450);
    context.transform(1.25, 0, 0, -1.25, 0, 450);

    context.fillStyle = "#ffffff";
    context.fill(new Path2D(BUS_WHITE_CIRCLE_D));

    context.fillStyle = color;
    context.fill(new Path2D(BUS_RING_D));

    context.fillStyle = color;
    context.fill(new Path2D(BUS_H_D));
    context.restore();
  }

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Padded high-DPI selection outline indicator for selected station area. */
function selectedStationOutlineImage(mode: StationAreaMode): ImageData {
  const pixelRatio = 2;
  const visualSize = STATION_ICON_VISUAL_SIZES[mode];
  const padding = STATION_ICON_PADDING;
  const totalSize = visualSize + padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = totalSize * pixelRatio;
  canvas.height = canvas.width;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(canvas.width, canvas.height);
  context.scale(pixelRatio, pixelRatio);

  const cx = totalSize / 2;
  const cy = totalSize / 2;
  const selectSize = visualSize + 6;
  const selectPadding = (totalSize - selectSize) / 2;

  context.save();
  if (mode === "sbahn" || mode === "bus") {
    context.beginPath();
    context.arc(cx, cy, selectSize / 2, 0, Math.PI * 2);
  } else {
    context.beginPath();
    const corner = selectSize * (60 / 500) + 1.5;
    if (typeof context.roundRect === "function") {
      context.roundRect(selectPadding, selectPadding, selectSize, selectSize, corner);
    } else {
      context.rect(selectPadding, selectPadding, selectSize, selectSize);
    }
  }
  context.lineWidth = 2.5;
  context.strokeStyle = "#202522";
  context.stroke();
  context.restore();

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function syncOrigins(map: Map, participants: readonly MapParticipant[], markers: MutableRefObject<globalThis.Map<string, Marker>>) {
  const ids = new Set(participants.map((p) => p.id));
  markers.current.forEach((marker, id) => { if (!ids.has(id)) { marker.remove(); markers.current.delete(id); } });
  participants.forEach((p) => {
    let marker = markers.current.get(p.id);
    if (!marker) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "meeet-origin-marker";
      element.innerHTML = PIN_SVG;
      element.style.color = p.color;
      element.setAttribute("aria-label", `${p.label} origin.`);
      marker = new Marker({ element, anchor: "bottom" }).setLngLat([p.longitude, p.latitude]).addTo(map);
      markers.current.set(p.id, marker);
    } else marker.setLngLat([p.longitude, p.latitude]);
  });
}

export default function MapLibreCanvas({ participants, stationAreas, resultState, selectedStationAreaId = null, onStationAreaSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const markersRef = useRef(new globalThis.Map<string, Marker>());
  const inputs = useRef({ onStationAreaSelect });
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [markersReady, setMarkersReady] = useState(false);
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL;
  const attribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION;
  const stations = useMemo(() => stationData(stationAreas), [stationAreas]);
  const [territoryFeatureCount, setTerritoryFeatureCount] = useState(0);
  const [tooltip, setTooltip] = useState<{ name: string; stationAreaId: string; x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputs.current = { onStationAreaSelect }; }, [onStationAreaSelect]);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    const frame = containerRef.current;
    if (!el || !tooltip || !frame) return;
    const offset = 14;
    const gap = 10;
    const maxLeft = Math.max(frame.clientWidth - el.offsetWidth - gap, gap);
    const maxTop = Math.max(frame.clientHeight - el.offsetHeight - gap, gap);
    el.style.left = `${Math.min(Math.max(tooltip.x + offset, gap), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(tooltip.y + offset, gap), maxTop)}px`;
  }, [tooltip]);

  useEffect(() => {
    if (!containerRef.current) { setState("unavailable"); return; }
    let active = true;
    let map: Map | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const currentMarkers = markersRef.current;
    const fail = () => { if (active) setState("unavailable"); };

    try {
      map = new Map({ container: containerRef.current, style: styleUrl, center: MUNICH_CENTER, zoom: 11, attributionControl: false });
      mapRef.current = map;
      if (process.env.NODE_ENV !== "production") (window as unknown as { __meeetMap?: Map }).__meeetMap = map;
      resizeObserver = new ResizeObserver(() => map?.resize());
      resizeObserver.observe(containerRef.current);
      map.addControl(new AttributionControl({ compact: true, customAttribution: attribution }), "bottom-right");
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("error", fail);

      map.once("style.load", () => {
        if (!map || !active) return;
        if (!(map.getStyle().layers?.some((layer) => layer.type !== "background") ?? false)) { fail(); return; }

        map.addSource("meeet-territories", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        (["red", "blue", "fair"] as const).forEach((classification) => {
          map!.addLayer({
            id: `meeet-territory-${classification}`,
            type: "fill",
            source: "meeet-territories",
            filter: ["==", ["get", "classification"], classification],
            paint: { "fill-color": STATION_COLORS[classification], "fill-opacity": TERRITORY_FILL_OPACITY },
          });
        });

        map.addSource("meeet-station-areas", { type: "geojson", data: stationData([]) });

        STATION_ICON_PAINT_ORDER.forEach((mode) => {
          (["red", "blue", "fair", "unclassified"] as const).forEach((classification) => {
            map!.addImage(`meeet-station-${mode}-${classification}`, stationGlyphImage(mode, STATION_COLORS[classification]), { pixelRatio: 2 });
          });
          map!.addImage(`meeet-selected-station-${mode}`, selectedStationOutlineImage(mode), { pixelRatio: 2 });
        });

        STATION_ICON_PAINT_ORDER.forEach((mode) => {
          map!.addLayer({
            id: `meeet-stations-${mode}`,
            type: "symbol",
            source: "meeet-station-areas",
            // The coalesce keeps the pre-existing defensive bus default for features without a mode
            // (unreachable via stationData, which always sets mode).
            filter: ["==", ["coalesce", ["get", "mode"], "bus"], mode],
            layout: {
              "icon-image": ["concat", `meeet-station-${mode}-`, ["get", "classification"]],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-anchor": "center",
            },
          });
        });

        // The selection outline is intentionally the topmost canvas layer: it is the selected
        // station's selection indicator (not a transit icon in the ordering) and must wrap the
        // icon to be visible.
        map.addLayer({
          id: "meeet-selected-station-area",
          type: "symbol",
          source: "meeet-station-areas",
          filter: ["==", ["id"], ""],
          layout: {
            "icon-image": ["concat", "meeet-selected-station-", ["coalesce", ["get", "mode"], "bus"]],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-anchor": "center",
          },
        });

        const select = (event: MapLayerMouseEvent) => {
          const id = event.features?.[0]?.properties?.stationAreaId;
          if (typeof id === "string" && id.trim() !== "") inputs.current.onStationAreaSelect?.(id);
        };
        const hover = (event: MapLayerMouseEvent) => {
          const props = event.features?.[0]?.properties;
          if (typeof props?.name !== "string" || typeof props.stationAreaId !== "string") {
            setTooltip(null);
            return;
          }
          setTooltip({ name: props.name, stationAreaId: props.stationAreaId, x: event.point.x, y: event.point.y });
        };
        const hideTooltip = () => setTooltip(null);

        map.on("click", STATION_ICON_LAYERS, select);
        map.on("mouseout", hideTooltip);
        STATION_ICON_LAYERS.forEach((layer) => {
          map!.on("mouseenter", layer, () => { map!.getCanvas().style.cursor = "pointer"; });
          map!.on("mouseleave", layer, () => { map!.getCanvas().style.cursor = ""; });
          map!.on("mouseenter", layer, hover);
          map!.on("mousemove", layer, hover);
          map!.on("mouseleave", layer, hideTooltip);
        });
        setState("ready");
      });
    } catch { fail(); }

    return () => {
      active = false;
      setTooltip(null);
      resizeObserver?.disconnect();
      currentMarkers.forEach((marker) => marker.remove());
      currentMarkers.clear();
      map?.remove();
      if (process.env.NODE_ENV !== "production" && (window as unknown as { __meeetMap?: Map }).__meeetMap === map) {
        delete (window as unknown as { __meeetMap?: Map }).__meeetMap;
      }
      mapRef.current = null;
    };
  }, [attribution, styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || state !== "ready") return;
    setTooltip(null);
    setMarkersReady(false);
    const territorySource = map.getSource("meeet-territories") as GeoJSONSource | undefined;
    const stationSource = map.getSource("meeet-station-areas") as GeoJSONSource | undefined;
    territorySource?.setData({ type: "FeatureCollection", features: [] });
    stationSource?.setData(stations);
    const generated = territoryData(stationAreas, resultState);
    territorySource?.setData(generated);
    setTerritoryFeatureCount(generated.features.length);
    syncOrigins(map, participants, markersRef);
    const markReady = () => {
      if (!map || map !== mapRef.current) return;
      const ready = stationAreas.length === 0 || stationAreas.every((area) => map.queryRenderedFeatures(map.project([area.coordinate.longitude, area.coordinate.latitude]), { layers: STATION_ICON_LAYERS }).some((feature) => feature.properties?.stationAreaId === area.stationAreaId));
      if (ready) setMarkersReady(true);
    };
    map.once("idle", markReady);
    return () => { map.off("idle", markReady); };
  }, [stationAreas, stations, participants, state, resultState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || state !== "ready") return;
    map.setFilter("meeet-selected-station-area", ["==", ["id"], selectedStationAreaId ?? ""]);
  }, [selectedStationAreaId, state]);

  const label = resultState === "ok"
    ? `Munich meeting territory map with ${stationAreas.length} calculated station-area markers; unclassified territories are unfilled and gray markers are unclassified station areas`
    : resultState === "no-result"
    ? `Munich meeting territory map with ${stationAreas.length} unclassified station-area markers; unclassified territories are unfilled and gray markers are unclassified station areas`
    : "Munich meeting map with two participant origins; unclassified territories are unfilled and gray markers are unclassified station areas";

  return (
    <section
      className="map-frame"
      aria-label={label}
      data-map-state={state}
      data-map-style="configured"
      data-station-area-count={stationAreas.length}
      data-station-marker-count={stationAreas.length}
      data-station-markers-ready={markersReady ? "true" : "false"}
      data-territory-source="shared"
      data-territory-fill-layers="3"
      data-territory-fill-opacity={TERRITORY_FILL_OPACITY}
      data-territory-feature-count={territoryFeatureCount}
    >
      <h2 className="sr-only">Munich meeting map</h2>
      <div ref={containerRef} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />
      {state === "loading" && <div className="map-message" role="status">Loading Munich map…</div>}
      {state === "unavailable" && (
        <div className="map-message" role="status">
          <strong>Map unavailable</strong>
          <span>The station-area territory map is unavailable; unclassified territories are unfilled. The planned route calculation is still separate.</span>
        </div>
      )}
      {tooltip && state === "ready" && stationAreas.some((area) => area.stationAreaId === tooltip.stationAreaId) && (
        <div ref={tooltipRef} data-station-tooltip className="map-tooltip">{tooltip.name}</div>
      )}
    </section>
  );
}
