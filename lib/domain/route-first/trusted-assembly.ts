import "server-only";

import type { RouteSnapshotIdentity } from "./models.ts";
import type { RouteFirstMeetingRequest } from "./meeting-service.ts";
import type { RouteFirstClientSubmission } from "./request-contract.ts";

export const ROUTE_FIRST_ASSEMBLY_UNAVAILABLE_REASON = "Route-first trusted routing data is unavailable.";

export interface RouteFirstAssemblyContext {
  readonly sessionId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly workBudget: bigint;
}

export type RouteFirstTrustedAssemblyResult =
  | {
    readonly status: "ready";
    readonly request: RouteFirstMeetingRequest;
    /** Includes the trusted policy/manifest version, never caller input. */
    readonly cacheScope: string;
  }
  | {
    readonly status: "unavailable";
    readonly reason: "provider-unavailable" | "manifest-unavailable" | "assembly-failed";
  };

/**
 * Server-only assembly seam. Implementations own the immutable manifest,
 * graph, policy, journeys, target profiles, topology, and accessibility.
 */
export interface RouteFirstTrustedDataProvider {
  readonly snapshot: RouteSnapshotIdentity;
  readonly cacheScope: string;
  assemble(
    submission: RouteFirstClientSubmission,
    context: RouteFirstAssemblyContext,
  ): Promise<RouteFirstTrustedAssemblyResult> | RouteFirstTrustedAssemblyResult;
}
