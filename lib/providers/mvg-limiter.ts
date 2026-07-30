import { HttpProviderError, raceWithAbort } from "./http.ts";

export const MVG_DIRECT_MAX_CONCURRENCY = 4;

class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new HttpProviderError("aborted", "Provider request was aborted."));
    }
    return new Promise<T>((resolve, reject) => {
      let queued = true;
      let settled = false;
      const start = () => {
        if (settled) return;
        queued = false;
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          settled = true;
          reject(new HttpProviderError("aborted", "Provider request was aborted."));
          return;
        }
        this.active += 1;
        Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            settled = true;
            this.active -= 1;
            this.startNext();
          });
      };
      const abort = () => {
        if (!queued || settled) return;
        queued = false;
        settled = true;
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new HttpProviderError("aborted", "Provider request was aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (this.active < this.maximum) start();
      else this.queue.push(start);
    });
  }

  private startNext(): void {
    while (this.active < this.maximum) {
      const next = this.queue.shift();
      if (!next) return;
      next();
    }
  }
}

/** Shared by every direct MVG upstream fill and uncached request. */
export const MVG_DIRECT_LIMITER = new ConcurrencyLimiter(MVG_DIRECT_MAX_CONCURRENCY);

/**
 * Let an individual caller stop waiting without releasing the shared fill's
 * limiter slot before its upstream operation settles.
 */
export function runMvgDirectCacheFill<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const limiterSignal = signal ?? new AbortController().signal;
  return raceWithAbort(MVG_DIRECT_LIMITER.run(operation, limiterSignal), signal);
}
