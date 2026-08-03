import "server-only";

import { unavailableRouteEnumeration, type RouteEnumerationResult } from "./enumeration.ts";
import { createRouteFirstMeetingService, type RouteFirstMeetingEnumerationProvider, type RouteFirstMeetingService } from "./meeting-service.ts";
import { RouteFirstJobStore } from "./job-cache.ts";
import type { RouteEnumerationInput } from "./models.ts";
import type { RouteFirstTrustedDataProvider } from "./trusted-assembly.ts";

/**
 * The self-hosted route-first calculation foundation is intentionally disabled
 * until a verified MVG/MVV/OSM routing snapshot is configured.
 */
export const unavailableRouteFirstEnumerationProvider: RouteFirstMeetingEnumerationProvider = Object.freeze({
  enumerateRoutes(input: RouteEnumerationInput): RouteEnumerationResult {
    void input;
    return unavailableRouteEnumeration("Route-first calculation foundation is unavailable in this runtime.");
  },
});

/** Placeholder provenance is server-owned and intentionally cannot produce a result. */
export const unavailableRouteFirstSnapshot = Object.freeze({
  contractVersion: "route-first-unavailable/v1",
  manifestId: "unavailable",
  graphDigest: "unavailable",
  inputDigest: "unavailable",
});

export const unavailableRouteFirstTrustedDataProvider: RouteFirstTrustedDataProvider = Object.freeze({
  snapshot: unavailableRouteFirstSnapshot,
  cacheScope: "route-first-foundation-unavailable/v1",
  assemble() {
    return { status: "unavailable" as const, reason: "provider-unavailable" as const };
  },
});

const defaultRouteFirstMeetingService = createRouteFirstMeetingService(unavailableRouteFirstEnumerationProvider);
const defaultRouteFirstJobStore = new RouteFirstJobStore();

export function getDefaultRouteFirstMeetingService(): RouteFirstMeetingService {
  return defaultRouteFirstMeetingService;
}

export function getDefaultRouteFirstJobStore(): RouteFirstJobStore {
  return defaultRouteFirstJobStore;
}

export function getDefaultRouteFirstTrustedDataProvider(): RouteFirstTrustedDataProvider {
  return unavailableRouteFirstTrustedDataProvider;
}
