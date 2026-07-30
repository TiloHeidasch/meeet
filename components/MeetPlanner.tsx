"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import type { MapParticipant, MapPoi, MapResultState } from "./MapLibreCanvas";
import { validateMeetingCalculationResponse } from "@/lib/client/meeting-response";
import type { MeetingCalculationResponse, MeetingCalculationOkResponse } from "@/lib/client/meeting-response";
import { parseSelectedVenueRouteResponse } from "@/lib/domain/selected-venue-response";
import type { SelectedVenueRouteResponse } from "@/lib/domain/types";

const MapLibreCanvas = dynamic(() => import("./MapLibreCanvas"), {
  ssr: false,
  loading: () => <div className="map-surface grid min-h-[430px] place-items-center rounded-[1.75rem] border border-[#cbd7cd] text-sm text-[#526057]">Preparing configured map…</div>,
});

type Mode = "transit" | "bike" | "car";
type ProviderMode = "fixture" | "configured" | "mvg-direct-transit";
export type PlannerCapability = { mode: ProviderMode; supportedModes: Mode[] };
type LocationChoice = { label: string; lat: number; lng: number };
type LocationSearchResult = { label: string; latitude: number; longitude: number };
type Participant = { id: string; name: string; location: LocationChoice | null; mode: Mode };
type CalculationState = { response: MeetingCalculationResponse; submittedParticipants: Participant[] };
type RouteStep = { text: string; departureAt: string | null; arrivalAt: string | null };
type RouteLeg = { participantId: string; mode: Mode; status: "detailed" | "summary"; minutes: number | null; source: string; detail: string; steps: RouteStep[]; geometry: { type: "LineString"; coordinates: [number, number][] } | null };
type RouteResponse = { venue: SelectedVenueRouteResponse["venue"]; departureAt: string; legs: RouteLeg[] };

const MODE_LABELS: Record<Mode, string> = { transit: "Public transport", bike: "Bike", car: "Car" };
const MODE_SHORT: Record<Mode, string> = { transit: "Transit", bike: "Bike", car: "Car" };
const MODE_ICONS: Record<Mode, string> = { transit: "↔", bike: "⌁", car: "▱" };
const COLORS = ["#ef785e", "#276e66", "#c18a27", "#7654a5"];
const PARTICIPANT_NUMBER_TEXT = ["#202522", "#fffdf8", "#202522", "#fffdf8"];
let participantIdCounter = 0;

function createParticipantId() {
  participantIdCounter += 1;
  const uniquePart = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${participantIdCounter.toString(36)}`;
  return `participant-${uniquePart}`;
}

function initialParticipant(id: string, name: string, location: LocationChoice | null, mode: Mode): Participant {
  return { id, name, location, mode };
}

const INITIAL_PARTICIPANTS = [
  initialParticipant("participant-1", "Alex", null, "transit"),
  initialParticipant("participant-2", "Sam", null, "bike"),
];

function initialParticipantsFor(capability: PlannerCapability) {
  return capability.mode === "mvg-direct-transit"
    ? INITIAL_PARTICIPANTS.map((participant) => ({ ...participant, mode: "transit" as const }))
    : INITIAL_PARTICIPANTS;
}

function Icon({ name, size = 18 }: { name: "pin" | "plus" | "arrow" | "close" | "refresh"; size?: number }) {
  const paths = {
    pin: <><path d="M12 21s7-6.1 7-12A7 7 0 0 0 5 9c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2.2"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    arrow: <><path d="M5 12h13M13 6l6 6-6 6"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function isFixture(response: MeetingCalculationResponse) {
  return response.metadata.source.deployment === "fixture";
}

function estimateLabel(response: MeetingCalculationResponse) {
  if (isFixture(response)) return resultSourceLabel(response);
  if (response.metadata.source.dataKind === "scheduled") return "Scheduled estimates";
  if (response.metadata.source.dataKind === "live") return "Live estimates";
  return "Travel-time estimates";
}

function resultSourceLabel(response: MeetingCalculationResponse) {
  if (isFixture(response)) return "Local demo estimates · static demo venues";
  return `${response.metadata.provenance.routing.provider} routing · ${response.metadata.provenance.poi.provider} food and drink venues`;
}

function caveatLabel(response: MeetingCalculationResponse) {
  return response.metadata.approximation || "Sample-grid approximation; returned cells were checked at their center and four vertices.";
}

function isRouteCandidateResponse(response: MeetingCalculationResponse): response is Extract<MeetingCalculationResponse, { status: "ok" }> & { candidates: NonNullable<Extract<MeetingCalculationResponse, { status: "ok" }>["candidates"]> } {
  return response.status === "ok" && response.corridor.properties.kind === "route-candidate-search-area" && Array.isArray(response.candidates);
}

function meetingAreaHeading(response: Extract<MeetingCalculationResponse, { status: "ok" }>) {
  return isRouteCandidateResponse(response) ? "Verified candidate centers" : "Sample-grid meeting cells";
}

function CandidateSummary({ response }: { response: Extract<MeetingCalculationResponse, { status: "ok" }> }) {
  if (!isRouteCandidateResponse(response)) return null;
  const selected = response.candidates[0];
  return <div className="mb-4 rounded-xl border border-[#cbd7cd] bg-[#f1f7f2] p-3 text-xs leading-5 text-[#315e4d]">
    <p className="font-semibold text-[#202522]">Routed verified candidate centers</p>
    <p className="mt-1">{response.candidates.length} candidate centers passed the selected ±{response.requestSnapshot.tolerancePercent}% travel-time check.</p>
    <p className="mt-2 font-semibold text-[#165b47]">Best candidate center: {selected.label}</p>
    <ul className="mt-1 space-y-0.5 text-[#526057]">
      {response.candidates.map((candidate) => <li key={candidate.id}>{candidate.label}{candidate.id === selected.id ? " · selected" : ""}</li>)}
    </ul>
    <p className="mt-2 text-[#526057]">The map shows limited nearby-venue search buffers around these centers, not equal-time-proven areas.</p>
  </div>;
}

function formatDeparture(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function responseErrorMessage(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.message !== "string") return undefined;
  return payload.error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRouteResponse(value: unknown): RouteResponse | null {
  const parsed = parseSelectedVenueRouteResponse(value);
  if (!parsed) return null;
  return normalizeRouteResponse(parsed);
}

function normalizeRouteResponse(response: SelectedVenueRouteResponse): RouteResponse {
  return {
    venue: response.venue,
    departureAt: response.departureAt,
    legs: response.legs.map((leg) => ({
      participantId: leg.participantId,
      mode: leg.mode,
      status: leg.status,
      minutes: leg.durationMinutes === null ? null : Math.max(0, Math.round(leg.durationMinutes)),
      source: leg.source,
      detail: leg.summary,
      steps: leg.steps.map((step) => ({ text: step.instruction, departureAt: step.departureAt, arrivalAt: step.arrivalAt })),
      geometry: leg.geometry ? { type: "LineString", coordinates: leg.geometry.coordinates.map((point) => [point[0], point[1]] as [number, number]) } : null,
    })),
  };
}

function RouteOverview({ selected, route, routeState, submittedParticipants }: { selected: MeetingCalculationOkResponse["pois"][number] | null; route: RouteResponse | null; routeState: "idle" | "loading" | "error" | "ready"; submittedParticipants: readonly Participant[] }) {
  if (!selected) return <div className="mb-4 rounded-xl border border-dashed border-[#cbd7cd] px-3 py-3 text-xs leading-5 text-[#6b716b]"><p className="font-semibold text-[#202522]">Routes to your venue</p><p className="mt-1">Select a venue on the map or below to see each journey.</p></div>;
  return <section className="mb-4 rounded-xl border border-[#d7e3da] bg-[#f5faf6] p-3" aria-live="polite"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#1e7258]">Routes to venue</p><h3 className="mt-1 text-sm font-semibold text-[#202522]">{selected.name}</h3></div>{routeState === "loading" && <span className="text-[11px] text-[#526057]">Loading…</span>}</div>{routeState === "error" && <p className="mt-2 text-xs leading-5 text-[#a64e39]">Journey details are unavailable right now. The travel-time summary is still shown above.</p>}{routeState === "ready" && route?.legs.length === 0 && <p className="mt-2 text-xs text-[#526057]">No journey details were returned for this venue.</p>}{routeState === "ready" && route?.legs.map((leg, index) => { const person = submittedParticipants.find((item) => item.id === leg.participantId); return <div key={leg.participantId} className="mt-3 border-t border-[#d7e3da] pt-3"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLORS[index] ?? COLORS[0] }} />{person?.name || `Participant ${index + 1}`} · {MODE_LABELS[leg.mode]}</span><span className="font-bold text-[#165b47]">{leg.minutes === null ? "Duration unavailable" : `${leg.minutes} min`}</span></div><p className="mt-1 text-[11px] text-[#526057]">{leg.detail} · {leg.source}</p>{leg.steps.length > 0 && <ol className="mt-2 space-y-1 text-xs leading-4 text-[#315e4d]">{leg.steps.map((step, stepIndex) => <li key={`${leg.participantId}-${stepIndex}`}><span className="mr-1.5 font-semibold text-[#8f3f2d]">{stepIndex + 1}.</span>{step.text}</li>)}</ol>}{leg.status === "detailed" && leg.geometry && <p className="mt-2 text-[10px] text-[#6b716b]">Map line shows the approximate stop sequence, not exact turn-by-turn directions.</p>}</div>;})}</section>;
}

function rangeLabel(range: MeetingCalculationResponse extends never ? never : Extract<MeetingCalculationResponse, { status: "ok" }>['travelTimeRange']) {
  return `target ${Math.round(range.targetMinutes)} min · range ${Math.round(range.lowerMinutes)}–${Math.round(range.upperMinutes)} min`;
}

function MapCanvas({ calculation, participants: currentParticipants, selectedPoiId, onPoiSelect, routeLegs }: { calculation: CalculationState | null; participants: readonly Participant[]; selectedPoiId: string | null; onPoiSelect: (id: string) => void; routeLegs: readonly RouteLeg[] }) {
  const response = calculation?.response;
  const resultState: MapResultState = response?.status === "no-corridor" ? "no-candidate" : response?.status === "ok" ? "ok" : "initial";
  const snapshotParticipants = response?.requestSnapshot.participants;
  const participants: MapParticipant[] = (snapshotParticipants ?? currentParticipants.flatMap((participant) => participant.location ? [{ id: participant.id, location: { label: participant.location.label, latitude: participant.location.lat, longitude: participant.location.lng }, mode: participant.mode }] : [])).map((requestParticipant, index) => {
    const submitted = calculation?.submittedParticipants.find((participant) => participant.id === requestParticipant.id);
    return { id: requestParticipant.id, number: index + 1, label: submitted?.name || `Participant ${index + 1}`, mode: MODE_SHORT[requestParticipant.mode], latitude: requestParticipant.location.latitude, longitude: requestParticipant.location.longitude, color: COLORS[index] };
  });
  const pois: MapPoi[] = response?.status === "ok" ? response.pois.map((poi, index) => ({ ...poi, number: index + 1 })) : [];
  return <MapLibreCanvas corridor={response?.status === "ok" ? response.corridor : undefined} participants={participants} pois={pois} routeLegs={routeLegs.map((leg, index) => ({ participantId: leg.participantId, color: COLORS[index] ?? COLORS[0], geometry: leg.geometry }))} selectedPoiId={selectedPoiId} onPoiSelect={onPoiSelect} resultState={resultState} />;
}

function ParticipantRow({ participant, index, locationError, locationRef, onChange, onRemove, canRemove, disabled, supportedModes }: { participant: Participant; index: number; locationError?: string; locationRef: (element: HTMLInputElement | null) => void; onChange: (next: Participant) => void; onRemove: () => void; canRemove: boolean; disabled: boolean; supportedModes: readonly Mode[] }) {
  const modeName = `mode-${participant.id}`;
  const [query, setQuery] = useState(participant.location?.label ?? "");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [activeResult, setActiveResult] = useState(-1);
  const searchRequestRef = useRef(0);
  const searchControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    const trimmedQuery = query.trim();
    if (disabled || !trimmedQuery || trimmedQuery === participant.location?.label) {
      return;
    }
    const controller = new AbortController();
    searchControllerRef.current = controller;
    const timer = window.setTimeout(() => {
      setSearchState("loading");
      void fetch(`/api/locations/search?q=${encodeURIComponent(trimmedQuery)}`, { signal: controller.signal })
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok || !isRecord(payload) || !Array.isArray(payload.locations)) throw new Error("Search unavailable");
          return payload.locations.filter((location): location is LocationSearchResult => isRecord(location) && typeof location.label === "string" && typeof location.latitude === "number" && typeof location.longitude === "number");
        })
        .then((nextResults) => { if (requestId === searchRequestRef.current) { setResults(nextResults); setActiveResult(-1); setSearchState("idle"); } })
        .catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError") && requestId === searchRequestRef.current) { setResults([]); setSearchState("error"); } });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (searchControllerRef.current === controller) searchControllerRef.current = null;
    };
  }, [query, disabled, participant.location?.label]);

  function setQueryAndReset(nextQuery: string) {
    searchRequestRef.current += 1;
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setQuery(nextQuery);
    setResults([]);
    setActiveResult(-1);
    setSearchState("idle");
  }

  function selectLocation(result: LocationSearchResult) {
    searchRequestRef.current += 1;
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setQueryAndReset(result.label);
    onChange({ ...participant, location: { label: result.label, lat: result.latitude, lng: result.longitude } });
  }

  function handleLocationKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && results.length) { event.preventDefault(); setActiveResult((current) => (current + 1) % results.length); }
    if (event.key === "ArrowUp" && results.length) { event.preventDefault(); setActiveResult((current) => (current <= 0 ? results.length - 1 : current - 1)); }
    if (event.key === "Enter" && activeResult >= 0 && activeResult < results.length) {
      const result = results[activeResult];
      if (result) { event.preventDefault(); selectLocation(result); }
    }
    if (event.key === "Escape") {
      searchRequestRef.current += 1;
      searchControllerRef.current?.abort();
      searchControllerRef.current = null;
      setResults([]); setActiveResult(-1); setSearchState("idle");
    }
  }
  return <fieldset className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] p-4 shadow-[0_4px_16px_rgba(45,52,42,.04)]">
    <legend className="sr-only">Participant {index + 1}</legend>
    <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><span style={{ backgroundColor: COLORS[index], color: PARTICIPANT_NUMBER_TEXT[index] }} className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold">{index + 1}</span><span className="text-xs font-semibold uppercase tracking-[.15em] text-[#6b716b]">Participant {index + 1}</span></div>{canRemove && <button type="button" disabled={disabled} onClick={onRemove} className="rounded-lg p-1.5 text-[#526057] hover:bg-[#f4eee7] hover:text-[#202522] disabled:cursor-not-allowed disabled:opacity-50" aria-label={`Remove participant ${index + 1}`}><Icon name="close" size={16} /></button>}</div>
    <label className="mb-3 block"><span className="mb-1.5 block text-xs font-medium text-[#6b716b]">Label</span><input value={participant.name} onChange={(event) => onChange({ ...participant, name: event.target.value })} className="h-10 w-full rounded-xl border border-[#d9d8cf] bg-[#fffdf8] px-3 text-sm text-[#202522] placeholder:text-[#9da19a]" placeholder={`Participant ${index + 1}`} /></label>
    <div className="relative mb-3"><label className="block"><span className="mb-1.5 block text-xs font-medium text-[#6b716b]">Munich starting point</span><input ref={locationRef} value={query} disabled={disabled} onChange={(event) => { setQueryAndReset(event.target.value); setResults([]); if (participant.location) onChange({ ...participant, location: null }); }} onKeyDown={handleLocationKeyDown} role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={`location-results-${participant.id}`} aria-activedescendant={activeResult >= 0 ? `location-result-${participant.id}-${activeResult}` : undefined} aria-invalid={Boolean(locationError)} aria-describedby={locationError ? `location-error-${participant.id}` : `location-help-${participant.id}`} className={`h-11 w-full rounded-xl border bg-[#fffdf8] px-3 text-sm text-[#202522] placeholder:text-[#9da19a] disabled:cursor-not-allowed disabled:opacity-60 ${locationError ? "border-[#a64e39]" : "border-[#d9d8cf]"}`} placeholder="Search a street, station, or place" autoComplete="off" />{participant.location && <span className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#1e7258]" id={`location-help-${participant.id}`}><Icon name="pin" size={13} />Selected: {participant.location.label}</span>}{searchState === "loading" && <span className="mt-1.5 block text-xs text-[#6b716b]">Searching Munich…</span>}{searchState === "error" && <span className="mt-1.5 block text-xs text-[#a64e39]">Search is unavailable. Try again.</span>}</label>{results.length > 0 && <ul id={`location-results-${participant.id}`} role="listbox" className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-xl border border-[#cbd7cd] bg-[#fffdf8] p-1 shadow-[0_10px_25px_rgba(45,52,42,.16)]">{results.map((result, resultIndex) => <li key={`${result.label}-${result.latitude}-${result.longitude}`} id={`location-result-${participant.id}-${resultIndex}`} role="option" aria-selected={activeResult === resultIndex}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectLocation(result)} className={`w-full rounded-lg px-3 py-2.5 text-left text-sm text-[#202522] ${activeResult === resultIndex ? "bg-[#e3f1e8]" : "hover:bg-[#f0f5ef]"}`}>{result.label}</button></li>)}</ul>}{locationError && <span id={`location-error-${participant.id}`} className="mt-1.5 block text-xs font-medium text-[#a64e39]">{locationError}</span>}</div>
    <fieldset><legend className="mb-1.5 block text-xs font-medium text-[#6b716b]">Preferred mode</legend><div className="grid grid-cols-3 gap-1.5">{supportedModes.map((mode) => <label key={mode} className={`relative flex min-h-10 cursor-pointer flex-col items-center justify-center rounded-xl border px-1 text-[11px] font-semibold transition ${participant.mode === mode ? "border-[#1e7258] bg-[#e3f1e8] text-[#165b47]" : "border-[#b8beb7] text-[#526057] hover:border-[#276e66]"}`}><input className="peer sr-only" type="radio" name={modeName} value={mode} checked={participant.mode === mode} onChange={() => onChange({ ...participant, mode })} /><span className="text-base leading-4" aria-hidden="true">{MODE_ICONS[mode]}</span>{MODE_LABELS[mode]}<span className="pointer-events-none absolute inset-0 rounded-xl ring-[#215f93] peer-focus-visible:ring-2" /></label>)}</div></fieldset>
  </fieldset>;
}

export default function MeetPlanner({ capability }: { capability: PlannerCapability }) {
  const supportedModes = capability.supportedModes;
  const isDirectTransit = capability.mode === "mvg-direct-transit";
  const [participants, setParticipants] = useState<Participant[]>(() => initialParticipantsFor(capability));
  const [tolerance, setTolerance] = useState(10);
  const [calculation, setCalculation] = useState<CalculationState | null>(null);
  const [selectedPoi, setSelectedPoi] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "success" | "empty">("idle");
  const [message, setMessage] = useState("");
  const [locationErrors, setLocationErrors] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const locationRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const stale = Boolean(calculation && status !== "success" && status !== "empty");
  const successfulResponse = calculation?.response.status === "ok" ? calculation.response : null;
  const successfulCalculation = calculation?.response.status === "ok" ? calculation : null;
  const selected = useMemo(() => successfulResponse?.pois.find((poi) => poi.id === selectedPoi) ?? null, [successfulResponse, selectedPoi]);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeState, setRouteState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const routeAbortRef = useRef<AbortController | null>(null);
  const routeRequestRef = useRef(0);

  useEffect(() => {
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    const requestId = ++routeRequestRef.current;
    let active = true;
    if (!selected || !successfulCalculation || !successfulResponse) {
      queueMicrotask(() => { if (active) { setRoute(null); setRouteState("idle"); } });
      return () => { active = false; };
    }
    const controller = new AbortController();
    routeAbortRef.current = controller;
    queueMicrotask(() => { if (active) { setRoute(null); setRouteState("loading"); } });
    const participantsForRoute = successfulCalculation.submittedParticipants.map((participant) => ({ id: participant.id, location: participant.location ? { label: participant.location.label, latitude: participant.location.lat, longitude: participant.location.lng } : null, mode: participant.mode }));
    void fetch("/api/meeting/venue-routes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participants: participantsForRoute, selectedPoi: selected, departureAt: successfulResponse.requestSnapshot.departureAt }), signal: controller.signal })
      .then(async (response) => { const payload: unknown = await response.json().catch(() => null); if (!response.ok) throw new Error(responseErrorMessage(payload) || "Route details unavailable"); const parsed = parseRouteResponse(payload); if (!parsed) throw new Error("Route details unavailable"); return parsed; })
      .then((parsed) => { if (active && requestId === routeRequestRef.current) { setRoute(parsed); setRouteState("ready"); } })
      .catch((error) => { if (active && !(error instanceof DOMException && error.name === "AbortError") && requestId === routeRequestRef.current) setRouteState("error"); });
    return () => { active = false; controller.abort(); };
  }, [selected, successfulCalculation, successfulResponse]);

  function markInputChanged() {
    if (status === "loading") {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    }
    if (status === "loading" || calculation) {
      setStatus("idle");
      setMessage("Inputs changed. Update the meeting area.");
    }
  }
  function updateParticipant(index: number, next: Participant) {
    setParticipants((current) => current.map((item, itemIndex) => itemIndex === index ? next : item));
    if (next.location) setLocationErrors((current) => { const copy = { ...current }; delete copy[next.id]; return copy; });
    markInputChanged();
  }
  function addParticipant() {
    if (participants.length >= 4 || status === "loading") return;
    const added = initialParticipant(createParticipantId(), "", null, "transit");
    setParticipants((current) => current.length >= 4 ? current : [...current, added]);
    markInputChanged();
  }
  function removeParticipant(index: number) {
    if (participants.length <= 2 || status === "loading") return;
    setParticipants((current) => current.length <= 2 ? current : current.filter((_, itemIndex) => itemIndex !== index));
    markInputChanged();
  }

  async function calculate() {
    if (status === "loading") return;
    const errors: Record<string, string> = {};
    const invalid = participants.filter((participant) => !participant.location);
    invalid.forEach((participant) => { errors[participant.id] = "Choose a Munich starting point."; });
    if (invalid.length) {
      setLocationErrors(errors); setStatus("error"); setMessage("Choose a starting point for each participant before calculating.");
      requestAnimationFrame(() => locationRefs.current[invalid[0].id]?.focus());
      return;
    }
    const submittedParticipants = participants.map((participant) => ({ ...participant, location: participant.location ? { ...participant.location } : null }));
    const requestParticipants = submittedParticipants.map(({ id, location, mode }) => ({ id, location: { label: location!.label, latitude: location!.lat, longitude: location!.lng }, mode }));
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLocationErrors({}); setStatus("loading"); setMessage("Comparing travel-time estimates…"); setSelectedPoi(null);
    try {
      const response = await fetch("/api/meeting/calculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participants: requestParticipants, tolerancePercent: tolerance }), signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (requestId !== requestIdRef.current) return;
      if (!response.ok) {
        throw new Error(responseErrorMessage(payload) || "The travel-time estimates could not be calculated.");
      }
      const validation = validateMeetingCalculationResponse(payload);
      if (!validation.success) throw new Error("The calculation response could not be verified. Please try again.");
      const result = validation.data;
      if (result.status === "no-corridor") { setCalculation({ response: result, submittedParticipants }); setStatus("empty"); setMessage(result.reason.message); return; }
      if (result.status !== "ok") throw new Error("The calculation response was not recognized.");
      setCalculation({ response: result, submittedParticipants }); setStatus("success"); setMessage(result.pois.length ? `Meeting area ready with ${result.pois.length} venues from ${resultSourceLabel(result)}.` : "Meeting area ready. No venues were returned.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId === requestIdRef.current) { setStatus("error"); setMessage(error instanceof Error ? error.message : "The travel-time estimates could not be calculated."); }
    } finally {
      if (requestId === requestIdRef.current) abortRef.current = null;
    }
  }
  function handleSubmit(event: FormEvent) { event.preventDefault(); void calculate(); }

  return <main className="min-h-screen bg-[#f4f1eb] text-[#202522]"><AttributionSummary metadata={calculation?.response.metadata} /><div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-4 pb-6 pt-4 sm:px-6 lg:px-8">
    <header className="flex items-center justify-between pb-5"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#202522] text-lg font-black tracking-[-.12em] text-[#f5d873]">m</span><span className="text-xl font-bold tracking-[-.06em]">meeet</span></div><div className="hidden items-center gap-2 text-xs text-[#6b716b] sm:flex"><span className="h-2 w-2 rounded-full bg-[#1e7258]" /> Munich only · MVP</div></header>
    <div className="grid flex-1 gap-5 lg:grid-cols-[390px_minmax(0,1fr)]"><section className="order-2 flex flex-col lg:order-1"><div className="mb-5"><p className="mb-2 text-xs font-bold uppercase tracking-[.19em] text-[#d8644e]">Find the middle ground</p><h1 className="max-w-[320px] text-[2.35rem] font-semibold leading-[.98] tracking-[-.07em] sm:text-5xl">A fair place to meet.</h1><p className="mt-3 max-w-[330px] text-sm leading-6 text-[#6b716b]">Place everyone on the Munich map. We’ll find destinations within a similar travel time.</p></div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">{isDirectTransit && <div className="rounded-2xl border border-[#cbd7cd] bg-[#e8f2eb] px-4 py-3 text-xs leading-5 text-[#315e4d]"><p className="font-bold text-[#165b47]">MVG direct · public transport only</p><p className="mt-0.5">This connection uses MVG transit routes with realtime when supplied and scheduled time as the fallback, so every participant starts in public transport mode.</p></div>}{participants.map((participant, index) => <ParticipantRow key={participant.id} participant={participant} index={index} locationError={locationErrors[participant.id]} locationRef={(element) => { locationRefs.current[participant.id] = element; }} onChange={(next) => updateParticipant(index, next)} onRemove={() => removeParticipant(index)} canRemove={participants.length > 2} disabled={status === "loading"} supportedModes={supportedModes} />)}
        {participants.length < 4 && <button type="button" onClick={addParticipant} disabled={status === "loading"} className="flex h-11 items-center justify-center gap-2 rounded-xl border border-dashed border-[#8c9a8e] text-sm font-semibold text-[#276e66] transition hover:border-[#276e66] hover:bg-[#e8f2eb] disabled:cursor-not-allowed disabled:opacity-60"><Icon name="plus" size={16} /> Add participant <span className="text-xs font-normal text-[#526057]">({participants.length}/4)</span></button>}
        <fieldset className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] p-4"><legend className="sr-only">Travel-time tolerance</legend><div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">Travel-time tolerance</h2><p className="mt-1 text-xs text-[#6b716b]">How close the estimates need to be.</p></div><span className="rounded-full bg-[#f5eadb] px-2.5 py-1 text-xs font-bold text-[#96523d]">±{tolerance}%</span></div><div className="grid grid-cols-3 gap-2">{[5, 10, 15].map((value) => <label key={value} className={`relative flex h-9 cursor-pointer items-center justify-center rounded-lg border text-xs font-semibold ${tolerance === value ? "border-[#d8644e] bg-[#fff0e9] text-[#8f3f2d]" : "border-[#b8beb7] text-[#526057] hover:border-[#a64e39]"}`}><input className="peer sr-only" type="radio" name="tolerance" value={value} checked={tolerance === value} onChange={() => { setTolerance(value); markInputChanged(); }} /><span>±{value}%{value === 10 && <span className="ml-1 font-normal">default</span>}</span><span className="pointer-events-none absolute inset-0 rounded-lg ring-[#215f93] peer-focus-visible:ring-2" /></label>)}</div></fieldset>
        <button type="submit" disabled={status === "loading"} className="group flex h-13 items-center justify-center gap-2 rounded-2xl bg-[#202522] px-5 text-sm font-bold text-[#fffdf8] shadow-[0_8px_20px_rgba(32,37,34,.16)] transition hover:bg-[#31534a] disabled:cursor-wait disabled:opacity-70">{status === "loading" ? "Comparing estimates…" : calculation && status === "idle" ? "Update meeting area" : "Find meeting area"}<Icon name="arrow" size={18} /></button>
        <div aria-live="polite" className={`min-h-6 text-center text-xs leading-5 ${status === "error" || status === "empty" ? "text-[#a64e39]" : "text-[#6b716b]"}`}>{message || (isDirectTransit ? "MVG public transport · realtime when supplied; scheduled time fallback · static demo venues." : "Local demo only: static venues, no MVG/MVV timetable or realtime data.")}</div>
      </form></section>
      <section className="order-1 min-h-[480px] lg:order-2 lg:min-h-[calc(100vh-105px)]"><MapCanvas calculation={calculation} participants={participants} selectedPoiId={selectedPoi} onPoiSelect={setSelectedPoi} routeLegs={route?.legs ?? []} /><div className="relative z-30 -mt-5 mx-3 rounded-[1.5rem] border border-[#e4e2d9] bg-[#fffdf8] p-4 shadow-[0_12px_35px_rgba(45,52,42,.14)] lg:absolute lg:bottom-8 lg:right-8 lg:top-8 lg:mt-0 lg:ml-auto lg:w-[340px] lg:overflow-y-auto">
        {stale && calculation && <div className="mb-3 flex items-center justify-between rounded-xl border border-[#ead5ae] bg-[#fff8e8] px-3 py-2 text-xs text-[#765f2b]"><span>Previous response — inputs changed.</span><button type="button" disabled={status === "loading"} onClick={() => void calculate()} className="font-bold underline disabled:cursor-not-allowed disabled:opacity-50">Update</button></div>}
        {calculation?.response.status === "no-corridor" ? <><div className="mb-3 rounded-xl border border-[#ead5ae] bg-[#fff8e8] p-3 text-xs leading-5 text-[#765f2b]"><p className="font-bold">{stale ? "Previous response: no comparable meeting area" : "No comparable meeting area"}</p><p className="mt-1">{calculation.response.reason.message}</p></div><div className="mb-3 rounded-xl border border-[#d7e3da] bg-[#eef6f0] px-3 py-2 text-xs text-[#315e4d]">{resultSourceLabel(calculation.response)}{isFixture(calculation.response) && <span className="mt-1 block text-[#526057]">No MVG/MVV timetable or realtime data is used.</span>}</div><SnapshotSummary calculation={calculation} /></> : successfulCalculation ? <><div className="mb-3 flex items-center justify-between rounded-xl border border-[#d7e3da] bg-[#eef6f0] px-3 py-2 text-xs text-[#315e4d]"><span>{resultSourceLabel(successfulResponse!)}</span><span>{successfulResponse!.requestSnapshot.timeZone}</span></div>{isFixture(successfulResponse!) && <p className="mb-4 text-xs leading-5 text-[#6b716b]">No MVG/MVV timetable or realtime data is used.</p>}<div className="mb-4"><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#1e7258]">{stale ? "Previous meeting area" : "Meeting area ready"}</p><h2 className="mt-1 text-xl font-semibold tracking-[-.04em]">{meetingAreaHeading(successfulResponse!)}</h2></div><span className="rounded-full bg-[#e3f1e8] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#165b47]">±{successfulResponse!.requestSnapshot.tolerancePercent}%</span></div><p className="mt-2 text-xs leading-5 text-[#6b716b]">{estimateLabel(successfulResponse!)} for {successfulCalculation.submittedParticipants.length} people · {rangeLabel(successfulResponse!.travelTimeRange)}.</p></div><SnapshotSummary calculation={successfulCalculation} /><RouteOverview selected={selected} route={route} routeState={routeState} submittedParticipants={successfulCalculation.submittedParticipants} /><CandidateSummary response={successfulResponse!} /><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Nearby venues</h3><span className="text-xs text-[#777c74]">{successfulResponse!.pois.length} found</span></div>{successfulResponse!.pois.length ? <div className="space-y-2" aria-label="Food and drink demo venues">{successfulResponse!.pois.map((poi, index) => <button type="button" key={poi.id} onClick={() => setSelectedPoi(poi.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedPoi === poi.id ? "border-[#d8b74e] bg-[#fff8df]" : "border-[#e4e2d9] hover:border-[#aab7ad]"}`} aria-pressed={selectedPoi === poi.id}><div className="flex gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#f5d873] text-xs font-bold">{index + 1}</span><span><span className="block text-sm font-semibold">{poi.name}</span><span className="mt-0.5 block text-xs text-[#777c74]">{poi.category}{poi.address ? ` · ${poi.address}` : ""}</span></span></div></button>)}</div> : <div className="rounded-xl border border-dashed border-[#cfd5ce] px-4 py-5 text-center text-xs leading-5 text-[#777c74]">No static demo venues were returned.</div>}{selected && <div className="mt-3 rounded-xl bg-[#e8f2eb] p-3 text-xs"><p className="font-bold text-[#165b47]">Selected demo venue</p><p className="mt-1 font-semibold">{selected.name}</p><p className="mt-0.5 text-[#526057]">{selected.address || selected.category}</p></div>}<button type="button" disabled={status === "loading"} onClick={() => { setCalculation(null); setStatus("idle"); setMessage(""); setSelectedPoi(null); }} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-[#d9d8cf] py-2.5 text-xs font-bold text-[#526057] hover:bg-[#f4f1eb] disabled:opacity-60"><Icon name="refresh" size={15} /> Adjust participants</button></> : <div className="flex min-h-[165px] flex-col justify-center"><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#e3f1e8] text-[#1e7258]"><Icon name="pin" size={20} /></div><h2 className="text-lg font-semibold tracking-[-.04em]">Your shared map</h2><p className="mt-1 max-w-[280px] text-xs leading-5 text-[#777c74]">Choose a starting point for each person, then compare local demonstration estimates.</p>{status === "error" && <div className="mt-4 rounded-xl border border-[#efc7bd] bg-[#fff0e9] p-3 text-xs leading-5 text-[#a64e39]">{message}</div>}</div>}
      </div></section>
    </div>
  </div></main>;
}

function SnapshotSummary({ calculation }: { calculation: CalculationState }) {
  const { response, submittedParticipants } = calculation;
  return <div className="mb-4 rounded-xl border border-[#e4e2d9] bg-[#f4f1eb] p-3 text-xs text-[#526057]"><p className="font-semibold text-[#202522]">Submitted request</p><p className="mt-1">{formatDeparture(response.requestSnapshot.departureAt)} · {response.requestSnapshot.timeZone} · ±{response.requestSnapshot.tolerancePercent}%</p><p className="mt-2 leading-4">{caveatLabel(response)}</p><div className="mt-2 grid grid-cols-2 gap-2">{submittedParticipants.map((participant, index) => <div key={participant.id}><span className="font-semibold text-[#202522]"><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLORS[index] }} />{participant.name || `Person ${index + 1}`}</span><span className="block">{participant.location?.label} · {MODE_LABELS[participant.mode]}</span></div>)}</div></div>;
}

function AttributionSummary({ metadata }: { metadata?: MeetingCalculationResponse["metadata"] }) {
  const provenance = metadata?.provenance;
  return <details className="mx-2 mt-3 rounded-xl border border-[#cbd7cd] bg-[#fffdf8] p-3 text-[11px] leading-4 text-[#586159]"><summary className="cursor-pointer font-semibold text-[#202522]">Sources & attribution</summary><div className="mt-2 space-y-1.5">
    <p><a className="underline" href="https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=gsm_wfs%3Avablock_stadtbezirk&outputFormat=application%2Fjson&srsName=EPSG%3A4326" target="_blank" rel="noreferrer">Munich GeoPortal / GeodatenService</a> · <a className="underline" href="https://www.govdata.de/dl-de/by-2-0" target="_blank" rel="noreferrer">DL-DE-BY-2.0</a>; 25-district application boundary, not cadastral.</p>
    <p><strong>Routing:</strong> {provenance?.routing.attribution ?? "Verified provider provenance appears after calculation; no provider is used yet."} {provenance?.routing.feeds && <>MVG: {provenance.routing.feeds.mvg.attribution} MVV: {provenance.routing.feeds.mvv.attribution}</>}</p>
    <p><strong>Geocoding:</strong> {provenance?.geocoding.attribution ?? "Not requested yet."} · <strong>POIs:</strong> {provenance?.poi.attribution ?? "Not requested yet."}</p>
    <p><strong>Map:</strong> {process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || provenance?.map.attribution || "No configured map/tile attribution supplied."}</p>
  </div></details>;
}
