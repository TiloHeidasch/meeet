import "server-only";

const RUNNER_LOG_PREFIX = "[meeet]";
const COMPILER_LOG_PREFIX = "[compile]";

function formatLogMessage(prefix: string, message: string): string {
  return `${prefix} ${new Date().toISOString()} ${message}`;
}

/** Whole-millisecond elapsed time since the given performance.now() start. */
export function elapsedMs(startedAt: number): number {
  return Math.trunc(performance.now() - startedAt);
}

/** High-level runner lifecycle info to stdout (visible via docker logs). */
export function logInfo(message: string): void {
  console.log(formatLogMessage(RUNNER_LOG_PREFIX, message));
}

/** Runner errors and diagnostics to stderr. */
export function logError(message: string): void {
  console.error(formatLogMessage(RUNNER_LOG_PREFIX, message));
}

/**
 * Compiler progress to stderr. The compiler's stdout is a machine contract
 * (`action:reason`, output path) consumed by operators and downstream tooling,
 * so all human-readable progress must go to stderr.
 */
export function logCompilerProgress(message: string): void {
  console.error(formatLogMessage(COMPILER_LOG_PREFIX, message));
}