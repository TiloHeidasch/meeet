"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { assertRouteFirstClientJobEnvelope, type RouteFirstClientCompleteResult, type RouteFirstClientJobEnvelope, type RouteFirstClientJobStatus, type RouteFirstClientResult } from "@/lib/domain/route-first/client-contract";
import { buildRouteFirstMapEvidence, type RouteFirstMapEvidence } from "@/lib/client/route-first-map-evidence";
import { Rational } from "@/lib/domain/route-first/rational";

export type RouteFirstParticipantInput = {
  id: string;
  location: { latitude: number; longitude: number } | null;
  mode: "transit" | "bike" | "car";
};

type RouteFirstStatus = "idle" | "submitting" | "polling" | "complete" | "unavailable" | "incomplete" | "error" | "stopped";
export type RouteFirstEvidenceChange = (evidence: RouteFirstMapEvidence | null) => void;

export function canStartRouteFirstJob(available: boolean, status: RouteFirstStatus) {
  return available && status !== "submitting" && status !== "polling";
}

export function routeFirstStatusLabel(status: RouteFirstStatus): string {
  if (status === "submitting") return "Starting route-first check…";
  if (status === "polling") return "Checking certified route evidence…";
  if (status === "complete") return "Certified route-first result";
  if (status === "unavailable") return "Route-first is unavailable";
  if (status === "incomplete") return "Route-first result is incomplete";
  if (status === "error") return "Route-first check failed";
  if (status === "stopped") return "Route-first polling stopped";
  return "Route-first meeting evidence";
}

function resultStatus(status: RouteFirstClientJobStatus): RouteFirstStatus {
  if (status === "complete") return "complete";
  if (status === "unavailable" || status === "expired") return "unavailable";
  if (status === "incomplete") return "incomplete";
  if (status === "failed" || status === "no-eligible-target") return "error";
  return "polling";
}

function resultMessage(result: RouteFirstClientResult | undefined) {
  if (!result) return "The server has accepted the job but has not returned a result yet.";
  if (result.status === "unavailable") return "The configured route-first provider is not activated. No external route request was made by this UI.";
  if (result.status === "incomplete") return `Evidence is incomplete for ${result.participantId}; no route corridor or landmark result is shown.`;
  if (result.status === "failed") return `The route-first check failed safely (${result.code}).`;
  if (result.status === "no-eligible-target") return "No target passed the certified eligibility checks. No landmark is implied.";
  return "";
}

function durationText(startTau: string, endTau: string) {
  try {
    const duration = Rational.from(endTau).subtract(Rational.from(startTau));
    return `${duration.toString()} s`;
  } catch {
    return "duration unavailable";
  }
}

function CompleteOverview({ result, evidence, selectedFamily, onSelectFamily }: { result: RouteFirstClientCompleteResult; evidence: RouteFirstMapEvidence; selectedFamily: number; onSelectFamily: (index: number) => void }) {
  const family = result.families[selectedFamily] ?? result.families[0];
  const selectedJourneyIds = new Set(evidence.selectedJourneys.map((journey) => journey.journeyId));
  return <div className="space-y-3" data-testid="route-first-complete">
    <div className="rounded-2xl border border-[#c8ddcf] bg-[#edf7ef] p-4 text-sm text-[#315e4d]"><p className="font-bold text-[#165b47]">Certified route evidence</p><p className="mt-1 leading-5">Each participant has a validated journey. The corridor is directional and the fair region is bound to this same snapshot.</p></div>
    <fieldset className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] p-4"><legend className="text-sm font-semibold">Route family</legend><p className="mt-1 text-xs leading-5 text-[#6b716b]">Choose a certified alternative family. This changes the route evidence, not the tolerance.</p><div className="mt-3 grid gap-2">{result.families.map((item, index) => <label key={item.geometryKey} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-xs ${selectedFamily === index ? "border-[#1e7258] bg-[#e8f2eb]" : "border-[#d9d8cf]"}`}><input className="mt-0.5" type="radio" name="route-family" checked={selectedFamily === index} onChange={() => onSelectFamily(index)} /><span><span className="block font-bold text-[#202522]">Family {index + 1}</span><span className="mt-0.5 block leading-4 text-[#526057]">{item.pathKeys.length} certified route choice{item.pathKeys.length === 1 ? "" : "s"}; {item.eligibleComponents.length} eligible fair component{item.eligibleComponents.length === 1 ? "" : "s"}.</span></span></label>)}</div></fieldset>
    <section className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] p-4" aria-labelledby="route-first-times"><h3 id="route-first-times" className="text-sm font-semibold">Selected-family journeys</h3><p className="mt-1 text-xs leading-5 text-[#6b716b]">Certified alternatives are shown separately. An ambiguity envelope is not drawn.</p><div className="mt-3 space-y-2">{evidence.selectedJourneys.map((journey) => <div key={`${journey.journeyId}-${journey.familyPathKey}`} className="flex items-center justify-between gap-3 rounded-xl bg-[#f4f1eb] px-3 py-2.5 text-xs"><span className="font-semibold text-[#202522]">{journey.participantId}<span className="block text-[10px] font-normal text-[#6b716b]">{journey.role} alternative · {journey.modes.join(" → ")}</span></span><span className="text-right text-[#526057]">{durationText(journey.startTau, journey.endTau)}<span className="block text-[10px]">{journey.startTau}–{journey.endTau} exact window</span></span></div>)}{selectedJourneyIds.size === 0 && <p className="text-xs text-[#a64e39]">No map-ready journey was returned for this family.</p>}</div></section>
    <div className="rounded-2xl border border-[#ead5ae] bg-[#fff8e8] p-4 text-xs leading-5 text-[#765f2b]"><p className="font-bold">Tolerance ±{result.provenance.tolerancePercent}%</p><p className="mt-1">The map draws each certified exact directional corridor separately. An ambiguity envelope is not drawn.</p></div>
    <div className="rounded-2xl border border-[#d9d8cf] bg-[#fffdf8] p-4 text-xs text-[#526057]"><p className="font-semibold text-[#202522]">Selected-family map evidence</p><div className="mt-2 grid grid-cols-2 gap-2"><span><i className="mr-1.5 inline-block h-1 w-5 rounded bg-[#7654a5] align-middle" />directional route</span><span><i className="mr-1.5 inline-block h-1 w-5 rounded bg-[#d8644e] align-middle" />exact corridor</span><span><i className="mr-1.5 inline-block h-1.5 w-5 rounded bg-[#165b47] align-middle" />fair region</span><span><i className="mr-1.5 inline-block h-3 w-3 rounded-full border-2 border-[#202522] bg-[#f5d873] align-middle" />midpoint / fair point</span></div><p className="mt-2 text-[11px] leading-4">The map shows only certified WGS84 geometry returned by the adapter for this selected family. Alternate routes are dashed; no envelope or omitted landmark is drawn.</p></div>
    <section className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] p-4 text-xs leading-5 text-[#526057]"><p className="font-semibold text-[#202522]">Landmark eligibility</p><p className="mt-1">{result.landmarkEvaluation.evaluated && result.admittedLandmarks.length ? `${result.admittedLandmarks.length} landmark${result.admittedLandmarks.length === 1 ? " is" : "s are"} conditionally eligible after component-diversity checks.` : "No landmark is currently eligible. Route evidence alone does not make a place a landmark."}</p><p className="mt-2 text-[11px]">Family evidence: {family?.contextKey ?? "not selected"}</p></section>
  </div>;
}

export default function RouteFirstOverview({ participants, tolerance, available, onEvidenceChange }: { participants: readonly RouteFirstParticipantInput[]; tolerance: number; available: boolean; onEvidenceChange?: RouteFirstEvidenceChange }) {
  const [status, setStatus] = useState<RouteFirstStatus>("idle");
  const [message, setMessage] = useState("");
  const [job, setJob] = useState<RouteFirstClientJobEnvelope | null>(null);
  const [result, setResult] = useState<RouteFirstClientResult | null>(null);
  const [selectedFamily, setSelectedFamily] = useState(0);
  const sequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const locationsReady = participants.length >= 2 && participants.every((participant) => participant.location);
  const startable = canStartRouteFirstJob(available && Boolean(locationsReady), status);
  const complete = result?.status === "complete" ? result : null;

  const evidence = useMemo(() => {
    if (!complete) return null;
    try {
      const family = complete.families[selectedFamily] ?? complete.families[0];
      return buildRouteFirstMapEvidence(complete, { familyIndex: selectedFamily, contextKey: family.contextKey, skeletonKey: family.skeletonKey, geometryKey: family.geometryKey });
    } catch { return null; }
  }, [complete, selectedFamily]);

  useEffect(() => () => { sequence.current += 1; abortRef.current?.abort(); onEvidenceChange?.(null); }, [onEvidenceChange]);
  useEffect(() => {
    onEvidenceChange?.(evidence);
  }, [evidence, onEvidenceChange]);

  async function readEnvelope(response: Response) {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error("The route-first service could not accept this check.");
    return assertRouteFirstClientJobEnvelope(payload);
  }

  async function poll(jobId: string, requestSequence: number) {
    const controller = new AbortController(); abortRef.current = controller;
    for (;;) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
      if (requestSequence !== sequence.current) return;
      const response = await fetch(`/api/route-first/meetings/${encodeURIComponent(jobId)}`, { signal: controller.signal });
      const envelope = await readEnvelope(response);
      if (requestSequence !== sequence.current) return;
      onEvidenceChange?.(null);
      setJob(envelope); setResult(envelope.result ?? null); setStatus(resultStatus(envelope.status));
      if (["complete", "incomplete", "unavailable", "no-eligible-target", "failed", "expired"].includes(envelope.status)) return;
    }
  }

  async function start() {
    if (!startable) return;
    const requestSequence = ++sequence.current;
    abortRef.current?.abort();
    setStatus("submitting"); setMessage(""); setResult(null); setJob(null); setSelectedFamily(0);
    onEvidenceChange?.(null);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const body = { participants: participants.map((participant) => ({ participantId: participant.id, origin: participant.location!, mode: participant.mode })).sort((a, b) => a.participantId.localeCompare(b.participantId)), departureAt: new Date().toISOString(), tolerancePercent: String(tolerance) };
      const envelope = await readEnvelope(await fetch("/api/route-first/meetings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }));
      if (requestSequence !== sequence.current) return;
      onEvidenceChange?.(null);
      setJob(envelope); setResult(envelope.result ?? null); setStatus(resultStatus(envelope.status));
      if (["queued", "running"].includes(envelope.status)) await poll(envelope.jobId, requestSequence);
    } catch (error) {
      if (requestSequence !== sequence.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setStatus("error"); setMessage(error instanceof Error ? error.message : "The route-first check failed safely.");
    } finally { if (requestSequence === sequence.current) abortRef.current = null; }
  }

  function stop() { sequence.current += 1; abortRef.current?.abort(); abortRef.current = null; setResult(null); setJob(null); onEvidenceChange?.(null); setStatus("stopped"); setMessage("Polling stopped. The non-durable job was not promoted to a meeting result."); }
  const progress = status === "submitting" ? "Submitting a bounded participant request" : status === "polling" ? `Polling job ${job?.jobId ?? "…"}` : routeFirstStatusLabel(status);
  return <section className="mx-auto mt-5 w-full max-w-[1500px] rounded-[1.5rem] border border-[#d9d8cf] bg-[#f9f7f1] p-4 shadow-[0_8px_25px_rgba(45,52,42,.06)] sm:px-6 lg:px-8" aria-labelledby="route-first-title"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.17em] text-[#d8644e]">Route-first evidence</p><h2 id="route-first-title" className="mt-1 text-xl font-semibold tracking-[-.04em]">Routes before landmarks.</h2></div>{status !== "idle" && <span className="rounded-full bg-[#e8f2eb] px-2 py-1 text-[10px] font-bold text-[#165b47]">{routeFirstStatusLabel(status)}</span>}</div>
    <p className="mt-2 text-xs leading-5 text-[#6b716b]">A separate, certified route check can compare directional corridors and fair components. It never reuses the legacy POI-first calculation.</p>
    {!available && <div className="mt-3 rounded-xl border border-[#cbd7cd] bg-[#e8f2eb] p-3 text-xs leading-5 text-[#315e4d]" role="status"><p className="font-bold text-[#165b47]">Not activated</p><p className="mt-1">The configured self-hosted foundation does not send meeting calculation requests. Location search remains available; route-first evidence will appear after a durable provider is activated.</p></div>}
    {available && !locationsReady && <p className="mt-3 rounded-xl border border-[#ead5ae] bg-[#fff8e8] p-3 text-xs leading-5 text-[#765f2b]" role="status">Choose a Munich starting point for each participant before checking route evidence.</p>}
    {available && <div className="mt-3 flex gap-2"><button type="button" onClick={() => void start()} disabled={!startable} className="flex-1 rounded-xl bg-[#202522] px-4 py-3 text-xs font-bold text-[#fffdf8] transition hover:bg-[#31534a] disabled:cursor-not-allowed disabled:opacity-45">{status === "submitting" || status === "polling" ? "Checking route evidence…" : "Check route evidence"}</button>{(status === "submitting" || status === "polling") && <button type="button" onClick={stop} className="rounded-xl border border-[#a64e39] px-3 py-3 text-xs font-bold text-[#8f3f2d]">Stop</button>}</div>}
    {status !== "idle" && <div className="mt-3" aria-live="polite"><p className="text-xs font-semibold text-[#202522]">{progress}</p>{message && <p className="mt-1 text-xs text-[#a64e39]">{message}</p>}{result && result.status !== "complete" && <p className="mt-2 rounded-xl border border-[#ead5ae] bg-[#fff8e8] p-3 text-xs leading-5 text-[#765f2b]">{resultMessage(result)}</p>}</div>}
    {complete && evidence && <div className="mt-4"><CompleteOverview result={complete} evidence={evidence} selectedFamily={selectedFamily} onSelectFamily={setSelectedFamily} /></div>}
  </section>;
}
