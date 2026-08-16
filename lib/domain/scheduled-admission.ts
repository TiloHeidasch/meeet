import "server-only";

import { getOrCreateProcessValue } from "./process-registry.ts";

export const SCHEDULED_CALCULATION_CONCURRENCY = 1;
export const SCHEDULED_CALCULATION_DEADLINE_MS = 30_000;

export class ScheduledCalculationAdmissionError extends Error {
  constructor(message = "Scheduled calculations are temporarily unavailable.") {
    super(message);
    this.name = "ScheduledCalculationAdmissionError";
  }
}

export class ScheduledCalculationDeadlineError extends Error {
  constructor(message = "The scheduled meeting calculation exceeded its 30-second deadline.") {
    super(message);
    this.name = "ScheduledCalculationDeadlineError";
  }
}

/** A process-local, fail-closed admission gate for the full-feed calculation. */
export class ScheduledCalculationAdmission {
  private active = 0;

  constructor(limit: number = SCHEDULED_CALCULATION_CONCURRENCY) {
    if (limit !== SCHEDULED_CALCULATION_CONCURRENCY) {
      throw new RangeError("Scheduled calculation concurrency is fixed at one.");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  tryAcquire(): (() => void) | null {
    if (this.active >= SCHEDULED_CALCULATION_CONCURRENCY) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  acquire(): () => void {
    const release = this.tryAcquire();
    if (release === null) throw new ScheduledCalculationAdmissionError();
    return release;
  }

  /** Compatibility spelling for the explicit admission seam. */
  enter(): () => void {
    return this.acquire();
  }
}

export const scheduledCalculationAdmission = getOrCreateProcessValue(
  Symbol.for("meeet.scheduled-calculation-admission/v1"),
  () => new ScheduledCalculationAdmission(),
  isScheduledCalculationAdmission,
);

function isScheduledCalculationAdmission(value: unknown): value is ScheduledCalculationAdmission {
  return value instanceof ScheduledCalculationAdmission || (
    typeof value === "object" && value !== null &&
    typeof (value as { tryAcquire?: unknown }).tryAcquire === "function" &&
    typeof (value as { acquire?: unknown }).acquire === "function" &&
    typeof (value as { enter?: unknown }).enter === "function" &&
    typeof (value as { activeCount?: unknown }).activeCount === "number"
  );
}

export interface ScheduledDeadlineOptions {
  /** Test seam; production uses the fixed 30-second policy. */
  readonly deadlineMs?: number;
  /** Test seam for advancing time without sleeping. */
  readonly now?: () => number;
  /** Test seam for deterministic deadline cancellation. */
  readonly deadlineSignal?: AbortSignal;
}

export interface ScheduledCalculationDeadline {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly isExpired: () => boolean;
  readonly check: () => void;
  readonly dispose: () => void;
}

export function createScheduledCalculationDeadline(
  options: ScheduledDeadlineOptions & { readonly requestSignal?: AbortSignal } = {},
): ScheduledCalculationDeadline {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? SCHEDULED_CALCULATION_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new RangeError("The scheduled calculation deadline must be a non-negative finite duration.");
  }

  const deadlineController = new AbortController();
  const compositeController = new AbortController();
  const deadlineAt = now() + deadlineMs;
  const signals = [options.requestSignal, deadlineController.signal, options.deadlineSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const abortComposite = () => {
    if (!compositeController.signal.aborted) compositeController.abort();
  };
  for (const signal of signals) {
    if (signal.aborted) abortComposite();
    else signal.addEventListener("abort", abortComposite, { once: true });
  }

  const timer = setTimeout(() => deadlineController.abort(), deadlineMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }

  const isExpired = () => deadlineController.signal.aborted ||
    options.deadlineSignal?.aborted === true ||
    now() >= deadlineAt;
  const check = () => {
    if (!isExpired()) return;
    if (!deadlineController.signal.aborted) deadlineController.abort();
    throw new ScheduledCalculationDeadlineError();
  };
  const dispose = () => {
    clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener("abort", abortComposite);
  };
  return { signal: compositeController.signal, deadlineAt, isExpired, check, dispose };
}
