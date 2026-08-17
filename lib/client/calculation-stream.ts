// Client-safe SSE parser for the truthful calculation progress stream. This
// module runs in the browser and must stay free of server-only imports and
// node built-ins; the Node test runner exercises it directly.

import { insideOfficialMunichBoundary } from "./meeting-response.ts";
import {
  CALCULATION_PROGRESS_CONTRACT_VERSION,
  CALCULATION_PROGRESS_PHASES,
  type CalculationProgressPhase,
  type StationVerdict,
} from "../domain/calculation-progress-contract.ts";

export {
  CALCULATION_PROGRESS_CONTRACT_VERSION,
  CALCULATION_PROGRESS_PHASES,
  type CalculationProgressPhase,
  type StationVerdict,
};

export type CalculationStreamEvent =
  | { kind: "progress"; phase: CalculationProgressPhase }
  | { kind: "station-verdict"; verdict: StationVerdict }
  | { kind: "ref"; calculationRef: string }
  | { kind: "result"; result: unknown }
  | { kind: "error"; code: string; message: string };

export class CalculationStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculationStreamError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Node's web-streams runtime does not wire an AbortSignal into getReader, so
// reads are raced against an abort rejection to make read() reject with an
// AbortError when the signal fires (matching the browser behaviour).
const readWithAbort = (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> => {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
};

type ParsedFrame = { event: string; data: string };

function parseFrame(frame: string): ParsedFrame {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // id:, retry:, and unknown fields are ignored.
  }
  return { event, data: dataLines.join("\n") };
}

function dispatch(eventName: string, data: string, onEvent: (event: CalculationStreamEvent) => void): void {
  if (data === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new CalculationStreamError("Invalid JSON in calculation stream event.");
  }
  switch (eventName) {
    case "progress": {
      if (!isObject(parsed)) throw new CalculationStreamError("Invalid progress event in calculation stream.");
      if (parsed.contractVersion !== CALCULATION_PROGRESS_CONTRACT_VERSION) throw new CalculationStreamError("Unsupported calculation progress contract version.");
      if (typeof parsed.phase !== "string") throw new CalculationStreamError("Invalid progress event in calculation stream.");
      if ((CALCULATION_PROGRESS_PHASES as readonly string[]).includes(parsed.phase)) onEvent({ kind: "progress", phase: parsed.phase as CalculationProgressPhase });
      return;
    }
    case "station-verdict": {
      if (!isObject(parsed)) throw new CalculationStreamError("Invalid station-verdict event in calculation stream.");
      if (parsed.contractVersion !== CALCULATION_PROGRESS_CONTRACT_VERSION) throw new CalculationStreamError("Unsupported calculation progress contract version.");
      const coord = parsed.coordinate;
      if (
        typeof parsed.stationAreaId !== "string" ||
        parsed.stationAreaId.trim() === "" ||
        typeof parsed.name !== "string" ||
        parsed.name.trim() === "" ||
        !insideOfficialMunichBoundary(coord) ||
        typeof parsed.verdict !== "string" ||
        !["red", "blue", "fair", "unclassified"].includes(parsed.verdict)
      ) {
        throw new CalculationStreamError("Invalid station-verdict event in calculation stream.");
      }
      onEvent({
        kind: "station-verdict",
        verdict: {
          stationAreaId: parsed.stationAreaId,
          name: parsed.name,
          coordinate: {
            latitude: (coord as { latitude: number; longitude: number }).latitude,
            longitude: (coord as { latitude: number; longitude: number }).longitude,
          },
          verdict: parsed.verdict as "red" | "blue" | "fair" | "unclassified",
        },
      });
      return;
    }
    case "ref": {
      if (!isObject(parsed) || typeof parsed.calculationRef !== "string" || parsed.calculationRef === "") throw new CalculationStreamError("Invalid ref event in calculation stream.");
      onEvent({ kind: "ref", calculationRef: parsed.calculationRef });
      return;
    }
    case "result":
      onEvent({ kind: "result", result: parsed });
      return;
    case "error": {
      if (!isObject(parsed) || typeof parsed.code !== "string" || typeof parsed.message !== "string") throw new CalculationStreamError("Invalid error event in calculation stream.");
      onEvent({ kind: "error", code: parsed.code, message: parsed.message });
      return;
    }
    default:
      return;
  }
}

export async function readCalculationStream(response: Response, onEvent: (event: CalculationStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw new CalculationStreamError("Calculation stream response has no body.");
  const contentType = response.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().includes("text/event-stream")) throw new CalculationStreamError("Calculation stream response must be text/event-stream.");
  // The reader is narrowed to the default reader because the union return type
  // would otherwise require the BYOB `read(view)` argument.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = signal ? await readWithAbort(reader, signal) : await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseFrame(frame);
        dispatch(parsed.event, parsed.data, onEvent);
      }
    }
  } finally {
    reader.releaseLock();
  }
}