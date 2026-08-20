"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { validateMeetingResponse, type MeetingRequest, type MeetingResponse, type MeetingStationArea, type StationAreaMode } from "@/lib/client/meeting-response";
import { validateStationAreaDetails, type StationAreaDetail } from "@/lib/client/station-area-details";
import { CALCULATION_PROGRESS_PHASES, readCalculationStream, CalculationStreamError, type CalculationProgressPhase, type StationVerdict } from "@/lib/client/calculation-stream";
import { messages, useLocale, type Locale, type Messages } from "@/lib/client/i18n";

const MapLibreCanvas = dynamic(() => import("./MapLibreCanvas"), { ssr: false, loading: () => <MapLoading /> });
const COLORS = ["#e85d4a", "#3d70c9"] as const;
const PHASE_KEY: Record<CalculationProgressPhase, keyof Messages["phases"]> = { "access-seeds": "accessSeeds", "scheduled-routing": "scheduledRouting", "station-area-evaluation": "stationAreaEvaluation", "validating-result": "validatingResult" };
type Location = { label: string; lat: number; lng: number };
type SearchResult = { label: string; latitude: number; longitude: number };
type Participant = { id: "participant-1" | "participant-2"; location: Location | null };
type Status = "idle" | "loading" | "success" | "error";
export type PlannerCapability = { scheduled: { configurationAvailable: boolean; unavailableReason: "schedule-artifact-not-configured" | null } };
export type PlannerUiState = { calculationUnavailable: boolean; canCalculate: boolean; controlsDisabled: boolean; showModeSelector: false; unavailableMessage: string };
export function getPlannerUiState(capability: PlannerCapability, locale: Locale): PlannerUiState { const unavailable = !capability.scheduled.configurationAvailable; return { calculationUnavailable: unavailable, canCalculate: !unavailable, controlsDisabled: unavailable, showModeSelector: false, unavailableMessage: unavailable ? messages[locale].planner.unavailableMessage : "" }; }
export function canSubmitMeetingCalculation(ui: PlannerUiState, status: Status) { return ui.canCalculate && status !== "loading"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(value: unknown) { return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : undefined; }
function errorCode(value: unknown) { return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : undefined; }
export function nextStart(): string { return new Date(Math.ceil((Date.now() + 300_000) / 60_000) * 60_000).toISOString(); }
function formatDate(locale: Locale, iso: string) { return messages[locale].time.formatDate(iso); }
function formatSeconds(locale: Locale, value: number | null) { if (value === null) return messages[locale].time.noScheduledArrival; return messages[locale].time.formatSeconds(value); }
type ChangeTimePreset = "quick" | "medium" | "long";
function changeTimePresets(locale: Locale): readonly { readonly value: ChangeTimePreset; readonly label: string; readonly hint: string }[] { return [
  { value: "quick", label: messages[locale].changeTime.quick, hint: messages[locale].changeTime.quickHint },
  { value: "medium", label: messages[locale].changeTime.medium, hint: messages[locale].changeTime.mediumHint },
  { value: "long", label: messages[locale].changeTime.long, hint: messages[locale].changeTime.longHint },
]; }
function phaseLabel(locale: Locale, phase: CalculationProgressPhase) { return messages[locale].phases[PHASE_KEY[phase]]; }
function classificationLabel(locale: Locale, value: MeetingStationArea["classification"]) { return messages[locale].classification.label[value]; }
function classificationShort(locale: Locale, value: MeetingStationArea["classification"]) { return messages[locale].classification.short[value]; }
function MapLoading() { const locale = useLocale(); return <div className="map-surface grid min-h-[430px] place-items-center rounded-[1.75rem] text-sm text-[#526057]">{messages[locale].map.loading}</div>; }
function Icon({ name }: { name: "pin" | "chevron" }) { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={name === "chevron" ? "station-chevron" : undefined}>{name === "pin" ? <><path d="M12 21s7-6.1 7-12A7 7 0 0 0 5 9c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2"/></> : <path d="m6 9 6 6 6-6"/>}</svg>; }

const S_PATH = "M 472 131 L 471 132 L 458 132 L 457 133 L 448 133 L 447 134 L 434 135 L 433 136 L 428 136 L 398 143 L 376 150 L 356 158 L 330 171 L 312 182 L 286 202 L 265 223 L 253 238 L 242 255 L 229 282 L 223 300 L 219 317 L 218 329 L 217 330 L 217 340 L 216 341 L 217 384 L 218 385 L 220 403 L 227 428 L 231 438 L 243 461 L 249 470 L 266 490 L 292 512 L 319 529 L 350 544 L 406 564 L 409 564 L 416 567 L 444 574 L 448 576 L 455 577 L 459 579 L 496 588 L 500 590 L 507 591 L 546 603 L 549 605 L 557 607 L 572 614 L 574 614 L 590 622 L 604 631 L 622 647 L 630 658 L 636 670 L 640 687 L 640 705 L 637 716 L 632 726 L 624 737 L 608 752 L 596 760 L 578 769 L 564 774 L 548 778 L 537 779 L 536 780 L 496 781 L 495 780 L 483 780 L 482 779 L 468 778 L 467 777 L 462 777 L 461 776 L 456 776 L 446 773 L 442 773 L 405 762 L 402 760 L 387 755 L 380 751 L 378 751 L 343 733 L 312 713 L 276 684 L 248 656 L 232 637 L 222 623 L 222 770 L 248 791 L 290 817 L 332 837 L 352 845 L 360 847 L 363 849 L 366 849 L 369 851 L 375 852 L 395 859 L 419 865 L 423 865 L 428 867 L 443 869 L 444 870 L 450 870 L 451 871 L 463 872 L 464 873 L 472 873 L 473 874 L 501 875 L 502 876 L 542 875 L 543 874 L 561 873 L 562 872 L 568 872 L 569 871 L 590 868 L 610 863 L 617 860 L 620 860 L 647 850 L 674 837 L 700 821 L 728 799 L 751 776 L 767 756 L 777 741 L 793 711 L 799 696 L 806 673 L 806 669 L 809 658 L 809 652 L 810 651 L 810 642 L 811 641 L 810 600 L 809 599 L 809 592 L 808 591 L 806 576 L 798 550 L 789 531 L 778 514 L 771 505 L 752 486 L 726 467 L 694 450 L 692 450 L 667 439 L 619 424 L 571 412 L 554 409 L 541 405 L 537 405 L 505 397 L 501 395 L 494 394 L 477 388 L 474 388 L 443 376 L 421 364 L 409 355 L 398 344 L 392 336 L 386 325 L 382 313 L 381 302 L 380 301 L 380 284 L 381 283 L 382 274 L 390 256 L 404 240 L 418 230 L 441 220 L 458 217 L 459 216 L 466 216 L 467 215 L 508 215 L 509 216 L 519 216 L 520 217 L 527 217 L 528 218 L 546 220 L 572 226 L 603 236 L 623 245 L 625 245 L 662 264 L 689 281 L 716 301 L 752 333 L 766 348 L 766 225 L 743 208 L 721 194 L 679 172 L 677 172 L 670 168 L 645 158 L 603 145 L 595 144 L 576 139 L 566 138 L 565 137 L 559 137 L 558 136 L 552 136 L 544 134 L 536 134 L 535 133 L 508 132 L 507 131 Z";
const U_PATH = "M418.3 39.4h-100v261.2c0 47.7-16.9 81.6-68.8 81.6-52.3 0-69.3-33.9-69.3-81.6V39.4H81.7v270.9c0 113.4 91.3 155 167.7 155 76 0 168.8-41.5 168.8-155l.1-270.9z";
const T_PATH = "M 75 55 H 425 V 145 H 295 V 445 H 205 V 145 H 75 Z";
const BUS_WHITE_CIRCLE = "m 180,0 c -99.41,0 -180,80.59 -180,180 0,99.41 80.59,180 180,180 99.41,0 180,-80.59 180,-180 0,-99.41 -80.59,-180 -180,-180 z";
const BUS_RING = "m 352,180 c 0,96.57 -78.79,172 -172.03,172 C 86.73,352 8,276.57 8,180 c 0,-96.57 78.73,-172 171.97,-172 93.24,0 172.03,75.43 172.03,172 z m -48,0 c 0,-68.48 -55.52,-124 -124,-124 -68.48,0 -124,55.52 -124,124 0,68.48 55.52,124 124,124 68.48,0 124,-55.52 124,-124 z";
const BUS_H = "m 113.26,260 c -0.7,0 -1.26,-0.56 -1.26,-1.26 l 0,-157.48 c 0,-0.7 0.56,-1.26 1.26,-1.26 l 33.48,0 c 0.7,0 1.26,0.56 1.26,1.26 l 0,60.74 64,0 0,-60.74 c 0,-0.7 0.56,-1.26 1.26,-1.26 l 33.48,0 c 0.7,0 1.26,0.56 1.26,1.26 l 0,157.48 c 0,0.7 -0.56,1.26 -1.26,1.26 l -33.48,0 c -0.7,0 -1.26,-0.56 -1.26,-1.26 l 0,-60.74 -64,0 0,60.74 c 0,0.7 -0.56,1.26 -1.26,1.26 l -33.48,0 z";

function StationGlyph({ mode }: { mode: StationAreaMode }) {
  if (mode === "sbahn") {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 1000 1009" className="station-glyph">
        <circle cx="501" cy="502" r="474.5" fill="currentColor" />
        <path d={S_PATH} fill="#ffffff" />
      </svg>
    );
  }
  if (mode === "ubahn") {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 500 500" className="station-glyph">
        <rect width="500" height="500" rx="60" fill="currentColor" />
        <path fill="#ffffff" d={U_PATH} />
      </svg>
    );
  }
  if (mode === "tram") {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 500 500" className="station-glyph">
        <rect width="500" height="500" rx="60" fill="currentColor" />
        <path fill="#ffffff" d={T_PATH} />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 450 450" className="station-glyph">
      <g transform="matrix(1.25,0,0,-1.25,0,450)">
        <path fill="#ffffff" d={BUS_WHITE_CIRCLE} />
        <path fill="currentColor" d={BUS_RING} />
        <path fill="currentColor" d={BUS_H} />
      </g>
    </svg>
  );
}

function LocationInput({ participant, index, error, disabled, onChange }: { participant: Participant; index: number; error?: string; disabled: boolean; onChange: (location: Location) => void }) {
  const locale = useLocale(); const t = messages[locale];
  const [query, setQuery] = useState(participant.location?.label ?? ""); const [results, setResults] = useState<SearchResult[]>([]); const [searching, setSearching] = useState(false); const request = useRef(0);
  useEffect(() => { if (!query.trim() || disabled || query === participant.location?.label) return; const id = ++request.current; const timer = window.setTimeout(() => { setSearching(true); void fetch(`/api/locations/search?q=${encodeURIComponent(query)}`).then(async (response) => { const value: unknown = await response.json().catch(() => null); if (!response.ok || !isRecord(value) || !Array.isArray(value.locations)) throw new Error(); return value.locations.filter((item): item is SearchResult => isRecord(item) && typeof item.label === "string" && typeof item.latitude === "number" && typeof item.longitude === "number"); }).then((items) => { if (id === request.current) { setResults(items); setSearching(false); } }).catch(() => { if (id === request.current) { setResults([]); setSearching(false); } }); }, 220); return () => window.clearTimeout(timer); }, [query, disabled, participant.location?.label]);
  function choose(result: SearchResult) { request.current += 1; setQuery(result.label); setResults([]); onChange({ label: result.label, lat: result.latitude, lng: result.longitude }); }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) { if (event.key === "Escape") setResults([]); if (event.key === "Enter" && results[0]) { event.preventDefault(); choose(results[0]); } }
  const listboxId = `location-results-${index + 1}`; const inputId = `origin-input-${index + 1}`; return <fieldset className="origin-card"><legend className="sr-only">{t.location.participantOrigin(index + 1)}</legend><div className="origin-title"><span className="origin-number" style={{ backgroundColor: COLORS[index] }}>{index + 1}</span><span>{t.location.participant(index + 1)}</span><span className="origin-mode">{t.location.transit}</span></div><label htmlFor={inputId}><span className="field-label">{t.location.startingPointLabel}</span></label><span className="origin-input-wrap"><input id={inputId} value={query} disabled={disabled} onChange={(event) => { setQuery(event.target.value); setResults([]); }} onKeyDown={keyDown} role="combobox" aria-label={t.location.startingPointAria(index + 1)} aria-controls={listboxId} aria-expanded={results.length > 0} className={error ? "input-error" : ""} placeholder={t.location.placeholder} autoComplete="off" />{results.length > 0 && <ul id={listboxId} role="listbox" className="location-results">{results.map((result) => <li role="option" aria-selected="false" key={`${result.label}-${result.latitude}`}><button type="button" onClick={() => choose(result)}>{result.label}</button></li>)}</ul>}</span>{participant.location && <span className="selected-origin"><Icon name="pin"/> {participant.location.label}</span>}{searching && <span className="input-hint">{t.location.searching}</span>}{error && <span className="input-error-text">{error}</span>}</fieldset>;
}
function Legend() { const locale = useLocale(); const t = messages[locale]; return <div className="map-legend" aria-label={t.legend.ariaLabel}><span><i className="legend-swatch red"/> {t.legend.red}</span><span><i className="legend-swatch blue"/> {t.legend.blue}</span><span><i className="legend-swatch fair"/> {t.legend.fair}</span><span><i className="legend-swatch neutral"/> {t.legend.unclassified}</span></div>; }
function ScheduleDisclosure({ result }: { result: MeetingResponse }) { const locale = useLocale(); const t = messages[locale]; const schedule = result.metadata.schedule; const acquisition = schedule.acquisition; const surface = result.metadata.surface; return <details className="disclosure"><summary>{t.disclosure.summary}</summary><div className="disclosure-copy"><p><strong>{t.disclosure.scopeTitle}</strong> {t.disclosure.scope}</p><p><strong>{t.disclosure.plannedStart}</strong> {formatDate(locale, surface.searchStartAt)} · <strong>{t.disclosure.tolerance}</strong> ±{surface.selectedTolerancePercent}%</p><p><strong>{t.disclosure.schedule}</strong> {acquisition.feedVersion} · {t.disclosure.validRange(schedule.serviceDateRange.firstDate, schedule.serviceDateRange.lastDate)} · {schedule.timeZone}</p><p>{t.disclosure.territories}</p><p><strong>{t.disclosure.source}</strong> {acquisition.sourceUrl} · {t.disclosure.retrieved} {formatDate(locale, acquisition.retrievedAt)} · {acquisition.officialAttribution} · {acquisition.officialLicense.name}</p></div></details>; }
const UNAVAILABLE_KEY: Record<string, keyof Messages["unavailable"]> = { "no-access-seeds": "noAccessSeeds", "no-reachable-stations": "noReachableStations", "station-area-unclassified": "stationAreaUnclassified", "station-area-unavailable-for-participant": "stationAreaUnavailableForParticipant" };
function unavailableCopy(locale: Locale, reason: string | null) { return messages[locale].unavailable[reason ? UNAVAILABLE_KEY[reason] ?? "default" : "default"]; }
function DetailProvenance({ basis }: { basis: StationAreaDetail["basis"] }) { const locale = useLocale(); const t = messages[locale]; const schedule = basis.schedule; const acquisition = isRecord(schedule.acquisition) ? schedule.acquisition : {}; const access = basis.accessProvider; const accessProvenance = isRecord(access.provenance) ? access.provenance : {}; return <details className="detail-provenance"><summary>{t.provenance.summary}</summary><div className="detail-provenance-copy"><section><h3>{t.provenance.scheduleHeading}</h3><p><strong>{t.provenance.feed}</strong> {String(schedule.feedId)} · <strong>{t.provenance.timezone}</strong> {String(schedule.timeZone)}</p><p><strong>{t.provenance.valid}</strong> {String(isRecord(schedule.serviceDateRange) ? schedule.serviceDateRange.firstDate : "—")} to {String(isRecord(schedule.serviceDateRange) ? schedule.serviceDateRange.lastDate : "—")}</p><p><strong>{t.provenance.feedVersion}</strong> {String(acquisition.feedVersion)} · <strong>{t.provenance.retrieved}</strong> {String(acquisition.retrievedAt)}</p><p><strong>{t.provenance.source}</strong> {String(acquisition.sourceUrl)}</p><p><strong>{t.provenance.officialAttribution}</strong> {String(acquisition.officialAttribution)} · <strong>{t.provenance.license}</strong> {String(isRecord(acquisition.officialLicense) ? acquisition.officialLicense.name : "—")}</p></section><section><h3>{t.provenance.accessHeading}</h3><p><strong>{t.provenance.provider}</strong> {String(access.name)} · <strong>{t.provenance.dataKind}</strong> {String(access.dataKind)}</p><p><strong>{t.provenance.deployment}</strong> {String(access.deployment)} · <strong>{t.provenance.asOf}</strong> {String(access.asOf)} · {t.provenance.nonLive}</p><p><strong>{t.provenance.provenance}</strong> {String(accessProvenance.provider)} · {t.provenance.version} {String(accessProvenance.version)} · {t.provenance.retrievedAt} {String(accessProvenance.retrievedAt)}</p><p><strong>{t.provenance.attribution}</strong> {String(accessProvenance.attribution)}</p></section></div></details>; }

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
  const locale = useLocale(); const t = messages[locale];
  return (
    <section className="station-area-panel" aria-labelledby="station-area-heading" data-testid="station-area-list">
      <div className="station-area-heading">
        <div>
          <span className="field-label">{t.stationList.accessibleIndex}</span>
          <h2 id="station-area-heading">{t.stationList.heading}</h2>
        </div>
        <span className="station-area-count">{areas.length}</span>
      </div>
      <p id="station-area-instructions" className="station-area-instructions">
        {t.stationList.instructions}
      </p>
      <ul className="station-area-list" aria-describedby="station-area-instructions">
        {areas.map((area) => {
          const isSelected = selectedId === area.stationAreaId;
          const name = `${area.name}, ${classificationLabel(locale, area.classification)}, ${t.stationList.participant(1)} ${formatSeconds(locale, area.redArrivalSeconds)}, ${t.stationList.participant(2)} ${formatSeconds(locale, area.blueArrivalSeconds)}`;
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
                <span className="station-area-marker" data-mode={area.mode} aria-hidden="true">
                  <StationGlyph mode={area.mode} />
                </span>
                <span className="station-area-copy">
                  <strong>{area.name}</strong>
                  <small>{classificationShort(locale, area.classification)}</small>
                </span>
                <span className="station-area-times">
                  <span>P1 {formatSeconds(locale, area.redArrivalSeconds)}</span>
                  <span>P2 {formatSeconds(locale, area.blueArrivalSeconds)}</span>
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
          {t.stationList.noResult}
        </p>
      )}
    </section>
  );
}
function DetailPanel({ detail, area, loading, error, noResult, reason, expired, onRecalculate }: { detail: StationAreaDetail | null; area: MeetingStationArea | null; loading: boolean; error: string; noResult: boolean; reason: string | null; expired: boolean; onRecalculate: () => void }) {
  const locale = useLocale(); const t = messages[locale];
  let content: React.ReactNode = <p>{t.detailPanel.selectPrompt}</p>;
  if (expired) content = <><strong>{area?.name ?? t.detailPanel.thisStationArea}</strong><p role="alert">{t.detailPanel.expired}</p><button type="button" className="recalculate-button" onClick={onRecalculate}>{t.detailPanel.recalculate}</button></>;
  else if (noResult && area) content = <><strong>{area.name}</strong><p>{t.detailPanel.noResult}</p><div className="participant-details"><article><h3>{t.detailPanel.participant(1)}</h3><p>{unavailableCopy(locale, reason)}</p></article><article><h3>{t.detailPanel.participant(2)}</h3><p>{unavailableCopy(locale, reason)}</p></article></div></>;
  else if (loading) content = <p>{t.detailPanel.loading(area?.name ?? t.detailPanel.thisStationArea)}</p>;
  else if (error) content = <p role="alert">{error}</p>;
  else if (detail) content = <><strong>{detail.stationArea.name}</strong><p>{classificationLabel(locale, detail.stationArea.classification)} · {t.detailPanel.tolerance(detail.basis.selectedTolerancePercent)}</p><p>{t.detailPanel.classificationExplanation(detail.basis.selectedTolerancePercent)}</p><DetailProvenance basis={detail.basis}/><div className="participant-details">{detail.participants.map((participant) => <article key={participant.id}><h3>{t.detailPanel.participant(participant.color === "red" ? 1 : 2)}</h3>{participant.status === "available" ? <p><strong>{formatSeconds(locale, participant.terminal.totalSeconds)}</strong> {t.detailPanel.total} · {t.detailPanel.arriveAt} {formatDate(locale, participant.terminal.arrivalAt!)}</p> : <p>{unavailableCopy(locale, participant.unavailableReason)}</p>}</article>)}</div></>;
  return <section className="station-detail-panel" aria-labelledby="station-detail-heading"><h2 id="station-detail-heading">{t.detailPanel.heading}</h2><div className="station-detail-live" aria-live="polite" aria-atomic="true">{content}</div></section>;
}

export default function MeetPlanner({ capability }: { capability: PlannerCapability }) {
  const locale = useLocale(); const t = messages[locale];
  const ui = getPlannerUiState(capability, locale);
  const [participants, setParticipants] = useState<Participant[]>([{ id: "participant-1", location: null }, { id: "participant-2", location: null }]);
  const [tolerance, setTolerance] = useState<5 | 10 | 15>(10);
  const [changeTime, setChangeTime] = useState<ChangeTimePreset>("medium");
  const [searchStartAt] = useState(nextStart);
  const [result, setResult] = useState<MeetingResponse | null>(null);
  const [progressiveVerdicts, setProgressiveVerdicts] = useState<readonly StationVerdict[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [calculationRef, setCalculationRef] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StationAreaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailExpired, setDetailExpired] = useState(false);
  const detailCache = useRef(new Map<string, StationAreaDetail>());
  const detailAbort = useRef<AbortController | null>(null);
  const detailRequestId = useRef(0);
  const requestRef = useRef(0);
  const [phase, setPhase] = useState<CalculationProgressPhase | null>(null);
  const streamAbort = useRef<AbortController | null>(null);

  function clearDetails() { detailAbort.current?.abort(); detailAbort.current = null; detailCache.current.clear(); setCalculationRef(null); setSelectedId(null); setDetail(null); setDetailError(""); setDetailLoading(false); setDetailExpired(false); }
  function changed() { if (result || progressiveVerdicts.length > 0) { clearDetails(); setProgressiveVerdicts([]); setResult(null); setStatus("idle"); setMessage(t.planner.inputsChanged); } }
  function cancelCalculation() { streamAbort.current?.abort(); requestRef.current += 1; setProgressiveVerdicts([]); setStatus("idle"); setPhase(null); setMessage(t.planner.cancelled); }
  function updateOrigin(index: number, location: Location) { setParticipants((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, location } : item)); setErrors({}); changed(); }

  async function selectStationArea(id: string) {
    const currentResult = result;
    const area = currentResult?.stationAreas.find((item) => item.stationAreaId === id);
    if (!area || !currentResult) return;
    detailAbort.current?.abort();
    detailAbort.current = null;
    setDetailLoading(false);
    const requestId = ++detailRequestId.current;
    setSelectedId(id);
    setDetail(null);
    setDetailError("");
    if (currentResult.status === "no-result") return;
    if (detailExpired) return;
    const ref = calculationRef;
    if (!ref) {
      setDetailError(t.planner.refNotRetained);
      return;
    }
    const key = `${ref}:${id}`;
    const cached = detailCache.current.get(key);
    if (cached) {
      setDetail(cached);
      return;
    }
    const controller = new AbortController();
    detailAbort.current = controller;
    setDetailLoading(true);
    try {
      const body: MeetingRequest = {
        contractVersion: "meeet-meeting/v3",
        participants: participants.map((item) => ({
          id: item.id,
          mode: "transit" as const,
          origin: { label: item.location!.label, latitude: item.location!.lat, longitude: item.location!.lng },
        })) as [MeetingRequest["participants"][0], MeetingRequest["participants"][1]],
        tolerancePercent: tolerance,
        changeTimePreset: changeTime,
        searchStartAt,
      };
      const response = await fetch(`/api/meeting/station-areas/${encodeURIComponent(id)}/details`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Meeet-Calculation-Ref": ref },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (errorCode(payload) === "CALCULATION_REF_EXPIRED") {
          detailCache.current.clear();
          setDetailExpired(true);
          return;
        }
        throw new Error(errorMessage(payload) || t.planner.detailsUnavailable);
      }
      const checked = validateStationAreaDetails(payload, currentResult, body, ref, id);
      if (!checked.success) throw new Error(t.planner.detailsLoadFailed);
      if (requestId !== detailRequestId.current || ref !== calculationRef) return;
      detailCache.current.set(key, checked.data);
      setDetail(checked.data);
    } catch (error) {
      if (!controller.signal.aborted && requestId === detailRequestId.current) setDetailError(error instanceof Error ? error.message : t.planner.detailsLoadFailed);
    } finally {
      if (!controller.signal.aborted && requestId === detailRequestId.current) setDetailLoading(false);
    }
  }

  async function calculate() {
    if (!canSubmitMeetingCalculation(ui, status)) return;
    const missing = participants.filter((item) => !item.location);
    if (missing.length || !searchStartAt) {
      const next: Record<string, string> = {};
      missing.forEach((item) => { next[item.id] = t.planner.chooseStartingPoint; });
      setErrors(next);
      setStatus("error");
      setMessage(t.planner.chooseBoth);
      return;
    }
    clearDetails();
    setProgressiveVerdicts([]);
    const request: MeetingRequest = {
      contractVersion: "meeet-meeting/v3",
      participants: [
        { id: participants[0]!.id, mode: "transit", origin: { label: participants[0]!.location!.label, latitude: participants[0]!.location!.lat, longitude: participants[0]!.location!.lng } },
        { id: participants[1]!.id, mode: "transit", origin: { label: participants[1]!.location!.label, latitude: participants[1]!.location!.lat, longitude: participants[1]!.location!.lng } },
      ],
      tolerancePercent: tolerance,
      changeTimePreset: changeTime,
      searchStartAt,
    };
    const id = ++requestRef.current;
    streamAbort.current?.abort();
    const controller = new AbortController();
    streamAbort.current = controller;
    setResult(null);
    setStatus("loading");
    setPhase(null);
    setMessage(t.planner.startingCalculation);
    let ref: string | null = null;
    let terminalResult: MeetingResponse | null = null;
    let terminalError: string | null = null;
    try {
      const response = await fetch("/api/meeting/calculate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (id !== requestRef.current) return;
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(errorMessage(payload) || t.planner.serviceUnavailable);
      }
      await readCalculationStream(response, (event) => {
        if (id !== requestRef.current) return;
        if (event.kind === "progress") setPhase(event.phase);
        else if (event.kind === "station-verdict") setProgressiveVerdicts((prev) => prev.some((item) => item.stationAreaId === event.verdict.stationAreaId) ? prev : [...prev, event.verdict]);
        else if (event.kind === "ref") ref = event.calculationRef;
        else if (event.kind === "result") {
          const parsed = validateMeetingResponse(event.result, request);
          if (!parsed.success) throw new Error(t.planner.surfaceVerificationFailed);
          terminalResult = parsed.data;
        } else if (event.kind === "error") terminalError = event.message;
      }, controller.signal);
      if (id !== requestRef.current) return;
      if (terminalError) throw new Error(terminalError);
      if (!terminalResult) throw new Error(t.planner.searchEndedWithoutResult);
      setCalculationRef(ref);
      setProgressiveVerdicts([]);
      setResult(terminalResult);
      setStatus("success");
      setPhase(null);
      setMessage("");
    } catch (error) {
      if (id === requestRef.current && !controller.signal.aborted) {
        clearDetails();
        setProgressiveVerdicts([]);
        setStatus("error");
        setMessage(error instanceof CalculationStreamError ? t.planner.streamVerificationFailed : error instanceof Error ? error.message : t.planner.searchFailed);
      }
    } finally {
      if (streamAbort.current === controller) streamAbort.current = null;
    }
  }

  function submit(event: FormEvent) { event.preventDefault(); void calculate(); }
  const progressiveStationAreas = useMemo(() => progressiveVerdicts.map((verdict): MeetingStationArea => ({
    stationAreaId: verdict.stationAreaId,
    name: verdict.name,
    coordinate: verdict.coordinate,
    mode: verdict.mode ?? "bus",
    classification: verdict.verdict,
    redArrivalSeconds: null,
    blueArrivalSeconds: null,
    fasterParticipant: null,
    withinSelectedTolerance: verdict.verdict === "fair",
  })), [progressiveVerdicts]);
  const sortedStationAreas = useMemo(() => sortStationAreasByWorstTime(result?.stationAreas ?? []), [result?.stationAreas]);
  const stationAreas = result?.stationAreas ?? progressiveStationAreas;
  const mapParticipants = participants.flatMap((item, index) => item.location ? [{ id: item.id, number: index + 1, label: t.planner.participantLabel(index + 1), latitude: item.location.lat, longitude: item.location.lng, color: COLORS[index]! }] : []);
  const noResult = result?.status === "no-result";
  const fairCount = result?.stationAreas.filter((area) => area.classification === "fair").length ?? 0;
  return (
    <main className="planner-shell">
      <div className="planner-inner">
        <header className="brand-bar">
          <div className="brand"><span className="brand-mark">m</span><span>meeet</span></div>
          <span className="scope-pill">{t.planner.scopePill}</span>
        </header>
        <div className="planner-grid">
          <section className="planner-copy">
            <div className="eyebrow">{t.planner.eyebrow}</div>
            <h1>{t.planner.headlinePart1}<br /><em>{t.planner.headlinePart2}</em></h1>
            <p className="lede">{t.planner.lede}</p>
            {ui.calculationUnavailable && <div className="state-card" role="status"><strong>{t.planner.searchUnavailable}</strong><span>{ui.unavailableMessage}</span></div>}
            <form onSubmit={submit} noValidate>
              <div className="origin-stack">
                <LocationInput participant={participants[0]!} index={0} error={errors["participant-1"]} disabled={ui.controlsDisabled || status === "loading"} onChange={(location) => updateOrigin(0, location)} />
                <LocationInput participant={participants[1]!} index={1} error={errors["participant-2"]} disabled={ui.controlsDisabled || status === "loading"} onChange={(location) => updateOrigin(1, location)} />
              </div>
              <div className="search-options">
                <label className="start-field">
                  <span className="field-label">{t.planner.plannedStart}</span>
                  <span className="start-value">{formatDate(locale, searchStartAt)}</span>
                  <small>{t.planner.startHint}</small>
                </label>
                <fieldset className="tolerance-field">
                  <legend className="field-label">{t.planner.tolerance}</legend>
                  <div className="tolerance-options">
                    {([5, 10, 15] as const).map((value) => (
                      <label key={value} className={tolerance === value ? "tolerance-selected" : ""}>
                        <input type="radio" name="tolerance" value={value} checked={tolerance === value} disabled={status === "loading"} onChange={() => { setTolerance(value); changed(); }} />
                        <span>±{value}%</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="tolerance-field change-time-field">
                  <legend className="field-label">{t.planner.changeTime}</legend>
                  <div className="tolerance-options">
                    {changeTimePresets(locale).map((preset) => (
                      <label key={preset.value} className={changeTime === preset.value ? "tolerance-selected" : ""}>
                        <input type="radio" name="change-time" value={preset.value} checked={changeTime === preset.value} disabled={status === "loading"} onChange={() => { setChangeTime(preset.value); changed(); }} />
                        <span className="change-time-option">{preset.label}<small>{preset.hint}</small></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <div className="search-actions">
                <button className="search-button" type="submit" disabled={!canSubmitMeetingCalculation(ui, status)}>
                  {status === "loading" && <span className="button-spinner" />}
                  {status === "loading" ? t.planner.calculating : "meeet!"}
                </button>
                {status === "loading" && <button type="button" className="cancel-button" data-testid="cancel-calculation" onClick={cancelCalculation}>{t.planner.cancel}</button>}
              </div>
              {message && <p className={`form-message ${status === "error" ? "error" : ""}`} role={status === "error" ? "alert" : "status"}>{message}</p>}
              {status === "error" && <button type="button" className="retry-button" data-testid="retry-calculation" onClick={() => void calculate()}>{t.planner.retry}</button>}
            </form>
            {status === "loading" && (
              <section className="progress-panel" data-testid="calculation-progress" aria-label={t.planner.progressAria}>
                <div className="progress-heading">
                  <span className="progress-indicator" aria-hidden="true" />
                  <strong className="progress-phase-label" aria-live="polite">{phase ? phaseLabel(locale, phase) : t.planner.progressStarting}</strong>
                </div>
                <ol className="progress-phases" aria-hidden="true">
                  {CALCULATION_PROGRESS_PHASES.map((item, index) => (
                    <li key={item} className={phase ? (index < CALCULATION_PROGRESS_PHASES.indexOf(phase) ? "done" : index === CALCULATION_PROGRESS_PHASES.indexOf(phase) ? "active" : "") : ""}>{phaseLabel(locale, item)}</li>
                  ))}
                </ol>
                <p className="progress-note">{t.planner.progressNote}</p>
              </section>
            )}
            {result && (
              <section className={`result-summary ${noResult ? "no-result" : ""}`}>
                <span className="eyebrow">{noResult ? t.planner.noResultEyebrow : t.planner.resultEyebrow}</span>
                {noResult ? (
                  <>
                    <h2>{t.planner.noResultHeading}</h2>
                    <p>{result.reason === "no-access-seeds" ? t.planner.noResultAccessSeeds : t.planner.noResultNoStations}</p>
                  </>
                ) : (
                  <>
                    <h2>{t.planner.resultHeading(fairCount)}</h2>
                    <p>{t.planner.resultTolerance(result.metadata.surface.selectedTolerancePercent)}</p>
                    <div className="context-strip">
                      <span className="context-item"><small>{t.contextStrip.plannedStart}</small><strong>{formatDate(locale, result.metadata.surface.searchStartAt)}</strong></span>
                      <span className="context-item"><small>{t.contextStrip.tolerance}</small><strong>±{result.metadata.surface.selectedTolerancePercent}%</strong></span>
                      <span className="context-item"><small>{t.contextStrip.basis}</small><strong>{t.contextStrip.basisValue}</strong></span>
                    </div>
                    <p className="result-action">{t.planner.resultAction(fairCount)}</p>
                  </>
                )}
                <ScheduleDisclosure result={result} />
              </section>
            )}
          </section>
          <section className="map-column">
            <div className="map-viewport">
              <MapLibreCanvas participants={mapParticipants} stationAreas={stationAreas} resultState={result ? (noResult ? "no-result" : "ok") : "initial"} selectedStationAreaId={selectedId} onStationAreaSelect={(id) => void selectStationArea(id)} />
              {result && <Legend />}
            </div>
            {result && <StationAreaList areas={sortedStationAreas} selectedId={selectedId} resultState={noResult ? "no-result" : "ok"} detail={detail} detailLoading={detailLoading} detailError={detailError} reason={result.reason} expired={detailExpired} onSelect={(id) => void selectStationArea(id)} onRecalculate={() => void calculate()} />}
          </section>
        </div>
        <footer className="planner-footer">{t.planner.footer}</footer>
      </div>
    </main>
  );
}
