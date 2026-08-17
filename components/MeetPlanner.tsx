"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { validateMeetingResponse, type MeetingRequest, type MeetingResponse, type MeetingStationArea } from "@/lib/client/meeting-response";
import { validateStationAreaDetails, type StationAreaDetail } from "@/lib/client/station-area-details";
import { readCalculationStream, type CalculationProgressPhase } from "@/lib/client/calculation-stream";

const MapLibreCanvas = dynamic(() => import("./MapLibreCanvas"), { ssr: false, loading: () => <div className="map-surface grid min-h-[430px] place-items-center rounded-[1.75rem] text-sm text-[#526057]">Preparing Munich map…</div> });
const COLORS = ["#e85d4a", "#3d70c9"] as const;
const PHASE_LABELS: Record<CalculationProgressPhase, string> = { "access-seeds": "Finding nearby transit access", "scheduled-routing": "Checking planned MVV journeys", "station-area-evaluation": "Comparing station areas", "validating-result": "Preparing the validated map" };
const PHASE_ORDER: readonly CalculationProgressPhase[] = ["access-seeds", "scheduled-routing", "station-area-evaluation", "validating-result"];
type Location = { label: string; lat: number; lng: number };
type SearchResult = { label: string; latitude: number; longitude: number };
type Participant = { id: "participant-1" | "participant-2"; location: Location | null };
type Status = "idle" | "loading" | "success" | "error";
export type PlannerCapability = { scheduled: { configurationAvailable: boolean; unavailableReason: "schedule-artifact-not-configured" | null } };
export type PlannerUiState = { calculationUnavailable: boolean; canCalculate: boolean; controlsDisabled: boolean; showModeSelector: false; unavailableMessage: string };
export function getPlannerUiState(capability: PlannerCapability): PlannerUiState { const unavailable = !capability.scheduled.configurationAvailable; return { calculationUnavailable: unavailable, canCalculate: !unavailable, controlsDisabled: unavailable, showModeSelector: false, unavailableMessage: unavailable ? "The scheduled MVV service is not available for this installation." : "" }; }
export function canSubmitMeetingCalculation(ui: PlannerUiState, status: Status) { return ui.canCalculate && status !== "loading"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(value: unknown) { return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : undefined; }
function errorCode(value: unknown) { return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : undefined; }
function nextStart(): string { return new Date(Math.ceil((Date.now() + 300_000) / 1000) * 1000).toISOString(); }
function formatDate(iso: string) { return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
function formatSeconds(value: number | null) { if (value === null) return "No scheduled arrival"; return `${Math.floor(value / 60)} min${value % 60 ? ` ${value % 60} sec` : ""}`; }
function terminalStopName(participant: StationAreaDetail["participants"][number], stationAreaName?: string) {
  for (const segment of participant.segments) {
    if (segment.kind === "transit" && segment.to.boardingStopId === participant.terminal.boardingStopId) return segment.to.name;
    if (segment.kind === "wait" && segment.at.boardingStopId === participant.terminal.boardingStopId) return segment.at.name;
    if (segment.kind === "identity-resolution" && "boardingStopId" in segment.to && segment.to.boardingStopId === participant.terminal.boardingStopId) return segment.to.name;
  }
  for (const segment of participant.segments) {
    if (segment.kind === "identity-resolution") return segment.to.name;
    if (segment.kind === "transit") return segment.to.name;
    if (segment.kind === "wait") return segment.at.name;
  }
  return stationAreaName ?? "the boarding stop";
}
function segmentLabel(segment: StationAreaDetail["participants"][number]["segments"][number]) { if (segment.kind === "walk") return segment.purpose === "origin-access" ? `Access walk from your start · ${formatSeconds(segment.durationSeconds)} · MVG access estimate` : segment.purpose === "station-area-access" ? `Geometric walking estimate to the boarding stop · ${formatSeconds(segment.durationSeconds)}` : `Geometric transfer walk estimate · ${formatSeconds(segment.durationSeconds)}`; if (segment.kind === "wait") return `Wait at ${segment.at.name} · ${formatSeconds(segment.durationSeconds)}`; if (segment.kind === "identity-resolution") return `Station identity match · ${segment.to.name} · no walking time`; return `Transit ${segment.line} to ${segment.to.name} · ${formatSeconds(segment.durationSeconds)}`; }
function classificationLabel(value: MeetingStationArea["classification"]) { return value === "red" ? "Red is quicker" : value === "blue" ? "Blue is quicker" : value === "fair" ? "Fair territory within tolerance" : "Unclassified"; }
function classificationShort(value: MeetingStationArea["classification"]) { return value === "red" ? "Red territory" : value === "blue" ? "Blue territory" : value === "fair" ? "Fair · within tolerance" : "Unclassified · no fill"; }
function Icon({ name }: { name: "pin" | "chevron" }) { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{name === "pin" ? <><path d="M12 21s7-6.1 7-12A7 7 0 0 0 5 9c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2"/></> : <path d="m6 9 6 6 6-6"/>}</svg>; }

function LocationInput({ participant, index, error, disabled, onChange }: { participant: Participant; index: number; error?: string; disabled: boolean; onChange: (location: Location) => void }) {
  const [query, setQuery] = useState(participant.location?.label ?? ""); const [results, setResults] = useState<SearchResult[]>([]); const [searching, setSearching] = useState(false); const request = useRef(0);
  useEffect(() => { if (!query.trim() || disabled || query === participant.location?.label) return; const id = ++request.current; const timer = window.setTimeout(() => { setSearching(true); void fetch(`/api/locations/search?q=${encodeURIComponent(query)}`).then(async (response) => { const value: unknown = await response.json().catch(() => null); if (!response.ok || !isRecord(value) || !Array.isArray(value.locations)) throw new Error(); return value.locations.filter((item): item is SearchResult => isRecord(item) && typeof item.label === "string" && typeof item.latitude === "number" && typeof item.longitude === "number"); }).then((items) => { if (id === request.current) { setResults(items); setSearching(false); } }).catch(() => { if (id === request.current) { setResults([]); setSearching(false); } }); }, 220); return () => window.clearTimeout(timer); }, [query, disabled, participant.location?.label]);
  function choose(result: SearchResult) { request.current += 1; setQuery(result.label); setResults([]); onChange({ label: result.label, lat: result.latitude, lng: result.longitude }); }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) { if (event.key === "Escape") setResults([]); if (event.key === "Enter" && results[0]) { event.preventDefault(); choose(results[0]); } }
  const listboxId = `location-results-${index + 1}`; const inputId = `origin-input-${index + 1}`; return <fieldset className="origin-card"><legend className="sr-only">Participant {index + 1} origin</legend><div className="origin-title"><span className="origin-number" style={{ backgroundColor: COLORS[index] }}>{index + 1}</span><span>Participant {index + 1}</span><span className="origin-mode">Transit</span></div><label htmlFor={inputId}><span className="field-label">Starting point in Munich</span></label><span className="origin-input-wrap"><input id={inputId} value={query} disabled={disabled} onChange={(event) => { setQuery(event.target.value); setResults([]); }} onKeyDown={keyDown} role="combobox" aria-label={`Participant ${index + 1} starting point`} aria-controls={listboxId} aria-expanded={results.length > 0} className={error ? "input-error" : ""} placeholder="Search a street, station, or place" autoComplete="off" />{results.length > 0 && <ul id={listboxId} role="listbox" className="location-results">{results.map((result) => <li role="option" aria-selected="false" key={`${result.label}-${result.latitude}`}><button type="button" onClick={() => choose(result)}>{result.label}</button></li>)}</ul>}</span>{participant.location && <span className="selected-origin"><Icon name="pin"/> {participant.location.label}</span>}{searching && <span className="input-hint">Looking within Munich…</span>}{error && <span className="input-error-text">{error}</span>}</fieldset>;
}
function Legend() { return <div className="map-legend" aria-label="Station-area territory legend"><span><i className="legend-swatch red"/> Red is quicker</span><span><i className="legend-swatch blue"/> Blue is quicker</span><span><i className="legend-swatch fair"/> Fair territory within tolerance</span><span><i className="legend-swatch neutral"/> Gray diamonds are unclassified station areas; unclassified territories are unfilled</span></div>; }
function ScheduleDisclosure({ result }: { result: MeetingResponse }) { const schedule = result.metadata.schedule; const acquisition = schedule.acquisition; const surface = result.metadata.surface; return <details className="disclosure"><summary>About this meeting surface</summary><div className="disclosure-copy"><p><strong>Munich / MVV scope.</strong> This search uses the installed scheduled MVV feed for Munich and nearby MVG access data. It is not a venue recommendation.</p><p><strong>Planned start:</strong> {formatDate(surface.searchStartAt)} · <strong>Tolerance:</strong> ±{surface.selectedTolerancePercent}%</p><p><strong>Schedule:</strong> {acquisition.feedVersion} · valid {schedule.serviceDateRange.firstDate} to {schedule.serviceDateRange.lastDate} · {schedule.timeZone}</p><p>The map groups calculated station areas into translucent territories. Unclassified territories are intentionally unfilled; gray diamonds identify unclassified station areas. The planned route calculation is evaluated separately using the disclosed scheduled-routing method; the final station segment uses a geometric walking estimate, not walking directions or navigation.</p><p><strong>Source:</strong> {acquisition.sourceUrl} · retrieved {formatDate(acquisition.retrievedAt)} · {acquisition.officialAttribution} · {acquisition.officialLicense.name}</p></div></details>; }
function unavailableCopy(reason: string | null) { switch (reason) { case "no-access-seeds": return "No nearby access seed was available for this participant, so no planned MVV route can be shown."; case "no-reachable-stations": return "The scheduled MVV search could not reach a station for this participant."; case "station-area-unclassified": return "This station area is unclassified, so scheduled evidence is unavailable for this participant."; case "station-area-unavailable-for-participant": return "This station area has no scheduled evidence for this participant."; default: return "Scheduled evidence is unavailable for this participant."; } }
function DetailProvenance({ basis }: { basis: StationAreaDetail["basis"] }) { const schedule = basis.schedule; const acquisition = isRecord(schedule.acquisition) ? schedule.acquisition : {}; const access = basis.accessProvider; const accessProvenance = isRecord(access.provenance) ? access.provenance : {}; return <details className="detail-provenance"><summary>Schedule and access provenance</summary><div className="detail-provenance-copy"><section><h3>Scheduled MVV feed</h3><p><strong>Feed:</strong> {String(schedule.feedId)} · <strong>Timezone:</strong> {String(schedule.timeZone)}</p><p><strong>Valid:</strong> {String(isRecord(schedule.serviceDateRange) ? schedule.serviceDateRange.firstDate : "—")} to {String(isRecord(schedule.serviceDateRange) ? schedule.serviceDateRange.lastDate : "—")}</p><p><strong>Feed version:</strong> {String(acquisition.feedVersion)} · <strong>Retrieved:</strong> {String(acquisition.retrievedAt)}</p><p><strong>Source:</strong> {String(acquisition.sourceUrl)}</p><p><strong>Official attribution:</strong> {String(acquisition.officialAttribution)} · <strong>License:</strong> {String(isRecord(acquisition.officialLicense) ? acquisition.officialLicense.name : "—")}</p></section><section><h3>Access data</h3><p><strong>Provider:</strong> {String(access.name)} · <strong>Data kind:</strong> {String(access.dataKind)}</p><p><strong>Deployment:</strong> {String(access.deployment)} · <strong>As of:</strong> {String(access.asOf)} · non-live access data</p><p><strong>Provenance:</strong> {String(accessProvenance.provider)} · version {String(accessProvenance.version)} · retrieved {String(accessProvenance.retrievedAt)}</p><p><strong>Attribution:</strong> {String(accessProvenance.attribution)}</p></section></div></details>; }

export function sortStationAreasByWorstTime(areas: readonly MeetingStationArea[]): MeetingStationArea[] {
  return [...areas].sort((a, b) => {
    const aBoth = a.redArrivalSeconds !== null && a.blueArrivalSeconds !== null;
    const bBoth = b.redArrivalSeconds !== null && b.blueArrivalSeconds !== null;
    if (aBoth && bBoth) {
      const aWorst = Math.max(a.redArrivalSeconds!, a.blueArrivalSeconds!);
      const bWorst = Math.max(b.redArrivalSeconds!, b.blueArrivalSeconds!);
      if (aWorst !== bWorst) return aWorst - bWorst;
      const aBest = Math.min(a.redArrivalSeconds!, a.blueArrivalSeconds!);
      const bBest = Math.min(b.redArrivalSeconds!, b.blueArrivalSeconds!);
      if (aBest !== bBest) return aBest - bBest;
      return a.name.localeCompare(b.name, "de");
    }
    if (aBoth !== bBoth) return aBoth ? -1 : 1;
    const aSingle = a.redArrivalSeconds !== null || a.blueArrivalSeconds !== null;
    const bSingle = b.redArrivalSeconds !== null || b.blueArrivalSeconds !== null;
    if (aSingle && bSingle) {
      const aTime = (a.redArrivalSeconds ?? a.blueArrivalSeconds)!;
      const bTime = (b.redArrivalSeconds ?? b.blueArrivalSeconds)!;
      if (aTime !== bTime) return aTime - bTime;
      return a.name.localeCompare(b.name, "de");
    }
    if (aSingle !== bSingle) return aSingle ? -1 : 1;
    return a.name.localeCompare(b.name, "de");
  });
}

function StationAreaList({
  areas,
  selectedId,
  resultState,
  detail,
  detailLoading,
  detailError,
  reason,
  expired,
  onSelect,
  onRecalculate,
}: {
  areas: readonly MeetingStationArea[];
  selectedId: string | null;
  resultState: "ok" | "no-result";
  detail: StationAreaDetail | null;
  detailLoading: boolean;
  detailError: string;
  reason: string | null;
  expired: boolean;
  onSelect: (id: string) => void;
  onRecalculate: () => void;
}) {
  return (
    <section className="station-area-panel" aria-labelledby="station-area-heading" data-testid="station-area-list">
      <div className="station-area-heading">
        <div>
          <span className="field-label">Accessible map index</span>
          <h2 id="station-area-heading">Calculated station areas</h2>
        </div>
        <span className="station-area-count">{areas.length}</span>
      </div>
      <p id="station-area-instructions" className="station-area-instructions">
        Select an area to inspect its scheduled comparison. Every gray station area is included.
      </p>
      <ul className="station-area-list" aria-describedby="station-area-instructions">
        {areas.map((area) => {
          const isSelected = selectedId === area.stationAreaId;
          const name = `${area.name}, ${classificationLabel(area.classification)}, Participant 1 ${formatSeconds(area.redArrivalSeconds)}, Participant 2 ${formatSeconds(area.blueArrivalSeconds)}`;
          return (
            <li key={area.stationAreaId} className={`station-area-item ${isSelected ? "selected" : ""}`}>
              <button
                type="button"
                className={`station-area-button station-${area.classification}`}
                data-station-area-id={area.stationAreaId}
                data-station-area-classification={area.classification}
                aria-label={name}
                aria-expanded={isSelected}
                aria-pressed={isSelected}
                onClick={() => onSelect(area.stationAreaId)}
              >
                <span className="station-area-marker" aria-hidden="true" />
                <span className="station-area-copy">
                  <strong>{area.name}</strong>
                  <small>{classificationShort(area.classification)}</small>
                </span>
                <span className="station-area-times">
                  <span>P1 {formatSeconds(area.redArrivalSeconds)}</span>
                  <span>P2 {formatSeconds(area.blueArrivalSeconds)}</span>
                </span>
                <Icon name="chevron" />
              </button>
              {isSelected && (
                <DetailPanel
                  detail={detail}
                  area={area}
                  loading={detailLoading}
                  error={detailError}
                  noResult={resultState === "no-result"}
                  reason={reason}
                  expired={expired}
                  onRecalculate={onRecalculate}
                />
              )}
            </li>
          );
        })}
      </ul>
      {resultState === "no-result" && (
        <p className="station-no-result">
          Scheduled evidence is unavailable for this result. These station areas remain shown for transparency.
        </p>
      )}
    </section>
  );
}
function DetailPanel({ detail, area, loading, error, noResult, reason, expired, onRecalculate }: { detail: StationAreaDetail | null; area: MeetingStationArea | null; loading: boolean; error: string; noResult: boolean; reason: string | null; expired: boolean; onRecalculate: () => void }) {
  let content: React.ReactNode = <p>Select a station area to inspect its scheduled comparison.</p>;
  if (expired) content = <><strong>{area?.name ?? "This station area"}</strong><p role="alert">The saved calculation reference has expired, so station-area details can no longer be verified for the markers shown. Recalculate the meeting surface to inspect details again.</p><button type="button" className="recalculate-button" onClick={onRecalculate}>Recalculate meeting surface</button></>;
  else if (noResult && area) content = <><strong>{area.name}</strong><p>Scheduled evidence is unavailable for this result.</p><div className="participant-details"><article><h3>Participant 1</h3><p>{unavailableCopy(reason)}</p></article><article><h3>Participant 2</h3><p>{unavailableCopy(reason)}</p></article></div></>;
  else if (loading) content = <p>Loading scheduled details for {area?.name ?? "this station area"}…</p>;
  else if (error) content = <p role="alert">{error}</p>;
  else if (detail) content = <><strong>{detail.stationArea.name}</strong><p>{classificationLabel(detail.stationArea.classification)} · tolerance ±{detail.basis.selectedTolerancePercent}%</p><p>This classification compares the two participants&apos; planned totals at the selected ±{detail.basis.selectedTolerancePercent}% tolerance.</p><DetailProvenance basis={detail.basis}/><div className="participant-details">{detail.participants.map((participant) => <article key={participant.id}><h3>Participant {participant.color === "red" ? "1" : "2"}</h3>{participant.status === "available" ? <><p><strong>{formatSeconds(participant.terminal.totalSeconds)}</strong> total · Arrive at {formatDate(participant.terminal.arrivalAt!)}</p><p>Ready at {terminalStopName(participant, detail.stationArea.name)}</p><ul>{participant.segments.map((segment, index) => <li key={`${segment.kind}-${index}`}>{segmentLabel(segment)}</li>)}</ul></> : <p>{unavailableCopy(participant.unavailableReason)}</p>}</article>)}</div></>;
  return <section className="station-detail-panel" aria-labelledby="station-detail-heading"><h2 id="station-detail-heading">Station-area details</h2><div className="station-detail-live" aria-live="polite" aria-atomic="true">{content}</div></section>;
}

export default function MeetPlanner({ capability }: { capability: PlannerCapability }) {
  const ui = getPlannerUiState(capability); const [participants, setParticipants] = useState<Participant[]>([{ id: "participant-1", location: null }, { id: "participant-2", location: null }]); const [tolerance, setTolerance] = useState<5 | 10 | 15>(10); const [searchStartAt] = useState(nextStart); const [result, setResult] = useState<MeetingResponse | null>(null); const [status, setStatus] = useState<Status>("idle"); const [message, setMessage] = useState(""); const [errors, setErrors] = useState<Record<string, string>>({}); const [calculationRef, setCalculationRef] = useState<string | null>(null); const [selectedId, setSelectedId] = useState<string | null>(null); const [detail, setDetail] = useState<StationAreaDetail | null>(null); const [detailLoading, setDetailLoading] = useState(false); const [detailError, setDetailError] = useState(""); const [detailExpired, setDetailExpired] = useState(false); const detailCache = useRef(new Map<string, StationAreaDetail>()); const detailAbort = useRef<AbortController | null>(null); const detailRequestId = useRef(0); const requestRef = useRef(0); const [phase, setPhase] = useState<CalculationProgressPhase | null>(null); const streamAbort = useRef<AbortController | null>(null);
  function clearDetails() { detailAbort.current?.abort(); detailAbort.current = null; detailCache.current.clear(); setCalculationRef(null); setSelectedId(null); setDetail(null); setDetailError(""); setDetailLoading(false); setDetailExpired(false); }
  function changed() { if (result) { clearDetails(); setResult(null); setStatus("idle"); setMessage("Your inputs changed. Run the meeting search again."); } }
  function cancelCalculation() { streamAbort.current?.abort(); requestRef.current += 1; setStatus("idle"); setPhase(null); setMessage("Calculation cancelled. Your inputs are preserved."); }
  function updateOrigin(index: number, location: Location) { setParticipants((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, location } : item)); setErrors({}); changed(); }
  async function selectStationArea(id: string) { const currentResult = result; const area = currentResult?.stationAreas.find((item) => item.stationAreaId === id); if (!area || !currentResult) return; detailAbort.current?.abort(); detailAbort.current = null; setDetailLoading(false); const requestId = ++detailRequestId.current; setSelectedId(id); setDetail(null); setDetailError(""); if (currentResult.status === "no-result") return; if (detailExpired) return; const ref = calculationRef; if (!ref) { setDetailError("Scheduled evidence is unavailable because the calculation reference was not retained safely."); return; } const key = `${ref}:${id}`; const cached = detailCache.current.get(key); if (cached) { setDetail(cached); return; } const controller = new AbortController(); detailAbort.current = controller; setDetailLoading(true); try { const body: MeetingRequest = { contractVersion: "meeet-meeting/v3", participants: participants.map((item) => ({ id: item.id, mode: "transit" as const, origin: { label: item.location!.label, latitude: item.location!.lat, longitude: item.location!.lng } })) as [MeetingRequest["participants"][0], MeetingRequest["participants"][1]], tolerancePercent: tolerance, searchStartAt }; const response = await fetch(`/api/meeting/station-areas/${encodeURIComponent(id)}/details`, { method: "POST", headers: { "Content-Type": "application/json", "Meeet-Calculation-Ref": ref }, body: JSON.stringify(body), signal: controller.signal }); const payload: unknown = await response.json().catch(() => null); if (!response.ok) { if (errorCode(payload) === "CALCULATION_REF_EXPIRED") { detailCache.current.clear(); setDetailExpired(true); return; } throw new Error(errorMessage(payload) || "The station-area details are unavailable right now."); } const checked = validateStationAreaDetails(payload, currentResult, body, ref, id); if (!checked.success) throw new Error(checked.message); if (requestId !== detailRequestId.current || ref !== calculationRef) return; detailCache.current.set(key, checked.data); setDetail(checked.data); } catch (error) { if (!controller.signal.aborted && requestId === detailRequestId.current) setDetailError(error instanceof Error ? error.message : "The station-area details could not be loaded."); } finally { if (!controller.signal.aborted && requestId === detailRequestId.current) setDetailLoading(false); } }
  async function calculate() { if (!canSubmitMeetingCalculation(ui, status)) return; const missing = participants.filter((item) => !item.location); if (missing.length || !searchStartAt) { const next: Record<string, string> = {}; missing.forEach((item) => { next[item.id] = "Choose a Munich starting point."; }); setErrors(next); setStatus("error"); setMessage("Choose both starting points before searching."); return; } clearDetails(); const request: MeetingRequest = { contractVersion: "meeet-meeting/v3", participants: [{ id: participants[0]!.id, mode: "transit", origin: { label: participants[0]!.location!.label, latitude: participants[0]!.location!.lat, longitude: participants[0]!.location!.lng } }, { id: participants[1]!.id, mode: "transit", origin: { label: participants[1]!.location!.label, latitude: participants[1]!.location!.lat, longitude: participants[1]!.location!.lng } }], tolerancePercent: tolerance, searchStartAt }; const id = ++requestRef.current; streamAbort.current?.abort(); const controller = new AbortController(); streamAbort.current = controller; setResult(null); setStatus("loading"); setPhase(null); setMessage("Starting the planned MVV calculation…"); let ref: string | null = null; let terminalResult: MeetingResponse | null = null; let terminalError: string | null = null; try { const response = await fetch("/api/meeting/calculate/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal }); if (id !== requestRef.current) return; if (!response.ok) { const payload: unknown = await response.json().catch(() => null); throw new Error(errorMessage(payload) || "The MVG meeting service is unavailable right now."); } await readCalculationStream(response, (event) => { if (id !== requestRef.current) return; if (event.kind === "progress") setPhase(event.phase); else if (event.kind === "ref") ref = event.calculationRef; else if (event.kind === "result") { const parsed = validateMeetingResponse(event.result, request); if (!parsed.success) throw new Error("The meeting surface could not be verified. Please try again."); terminalResult = parsed.data; } else if (event.kind === "error") terminalError = event.message; }, controller.signal); if (id !== requestRef.current) return; if (terminalError) throw new Error(terminalError); if (!terminalResult) throw new Error("The meeting search ended without a result. Please try again."); setCalculationRef(ref); setResult(terminalResult); setStatus("success"); setPhase(null); setMessage(""); } catch (error) { if (id === requestRef.current && !controller.signal.aborted) { clearDetails(); setStatus("error"); setMessage(error instanceof Error ? error.message : "The meeting search could not be completed."); } } finally { if (streamAbort.current === controller) streamAbort.current = null; } }
  function submit(event: FormEvent) { event.preventDefault(); void calculate(); }
  const sortedStationAreas = useMemo(() => sortStationAreasByWorstTime(result?.stationAreas ?? []), [result?.stationAreas]);
  const stationAreas = result?.stationAreas ?? [];
  const mapParticipants = participants.flatMap((item, index) => item.location ? [{ id: item.id, number: index + 1, label: `Participant ${index + 1}`, latitude: item.location.lat, longitude: item.location.lng, color: COLORS[index]! }] : []);
  const noResult = result?.status === "no-result";
  return <main className="planner-shell"><div className="planner-inner"><header className="brand-bar"><div className="brand"><span className="brand-mark">m</span><span>meeet</span></div><span className="scope-pill">Munich · MVV scheduled search</span></header><div className="planner-grid"><section className="planner-copy"><div className="eyebrow">A better place to meet</div><h1>Find the middle,<br/><em>without guessing.</em></h1><p className="lede">Two origins. One planned start. A map of where public transport gets you close enough.</p>{ui.calculationUnavailable && <div className="state-card" role="status"><strong>Meeting search unavailable</strong><span>{ui.unavailableMessage}</span></div>}<form onSubmit={submit} noValidate><div className="origin-stack"><LocationInput participant={participants[0]!} index={0} error={errors["participant-1"]} disabled={ui.controlsDisabled || status === "loading"} onChange={(location) => updateOrigin(0, location)}/><LocationInput participant={participants[1]!} index={1} error={errors["participant-2"]} disabled={ui.controlsDisabled || status === "loading"} onChange={(location) => updateOrigin(1, location)}/></div><div className="search-options"><label className="start-field"><span className="field-label">Planned start</span><span className="start-value">{formatDate(searchStartAt)}</span><small>Now + 5 minutes · whole seconds</small></label><fieldset className="tolerance-field"><legend className="field-label">Travel-time tolerance</legend><div className="tolerance-options">{([5, 10, 15] as const).map((value) => <label key={value} className={tolerance === value ? "tolerance-selected" : ""}><input type="radio" name="tolerance" value={value} checked={tolerance === value} disabled={status === "loading"} onChange={() => { setTolerance(value); changed(); }}/><span>±{value}%</span></label>)}</div></fieldset></div><div className="search-actions"><button className="search-button" type="submit" disabled={!canSubmitMeetingCalculation(ui, status)}>{status === "loading" && <span className="button-spinner"/>}{status === "loading" ? "Calculating…" : "Show meeting surface"}</button>{status === "loading" && <button type="button" className="cancel-button" data-testid="cancel-calculation" onClick={cancelCalculation}>Cancel</button>}</div>{message && <p className={`form-message ${status === "error" ? "error" : ""}`} role={status === "error" ? "alert" : "status"}>{message}</p>}{status === "error" && <button type="button" className="retry-button" data-testid="retry-calculation" onClick={() => void calculate()}>Try again</button>}</form>{status === "loading" && <section className="progress-panel" data-testid="calculation-progress" aria-label="Calculation progress"><div className="progress-heading"><span className="progress-indicator" aria-hidden="true"/><strong className="progress-phase-label" aria-live="polite">{phase ? PHASE_LABELS[phase] : "Starting the planned calculation…"}</strong></div><ol className="progress-phases" aria-hidden="true">{PHASE_ORDER.map((item, index) => <li key={item} className={phase ? (index < PHASE_ORDER.indexOf(phase) ? "done" : index === PHASE_ORDER.indexOf(phase) ? "active" : "") : ""}>{PHASE_LABELS[item]}</li>)}</ol><p className="progress-note">This is a planned MVV schedule calculation, not live transit information.</p></section>}{result && <section className={`result-summary ${noResult ? "no-result" : ""}`}><span className="eyebrow">{noResult ? "No meeting surface yet" : "Surface ready"}</span><h2>{noResult ? "No scheduled route reached the surface." : "A fair place to meet."}</h2><p>{noResult ? (result.reason === "no-access-seeds" ? "No nearby MVG access seed could be resolved for one or both origins, so the scheduled surface cannot be calculated." : "The MVV schedule could not reach a station from one or both origins during the planned search window.") : "Compare every eligible station area, then open the planned legs for either participant."}</p><ScheduleDisclosure result={result}/></section>}</section><section className="map-column"><div className="map-viewport"><MapLibreCanvas participants={mapParticipants} stationAreas={stationAreas} resultState={result ? (noResult ? "no-result" : "ok") : "initial"} selectedStationAreaId={selectedId} onStationAreaSelect={(id) => void selectStationArea(id)}/>{result && <Legend/>}</div>{result && <StationAreaList areas={sortedStationAreas} selectedId={selectedId} resultState={noResult ? "no-result" : "ok"} detail={detail} detailLoading={detailLoading} detailError={detailError} reason={result.reason} expired={detailExpired} onSelect={(id) => void selectStationArea(id)} onRecalculate={() => void calculate()}/>}</section></div><footer className="planner-footer">Scheduled MVV surface <span>•</span> Munich only <span>•</span> Built for two origins</footer></div></main>;
}
