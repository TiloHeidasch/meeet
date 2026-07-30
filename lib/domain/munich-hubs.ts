import type { RouteCandidate } from "./types.ts";

/** Explicit coordinate-only Munich meeting candidates; none is an MVG via claim. */
export const MUNICH_HUB_CANDIDATES: readonly RouteCandidate[] = [
  {
    id: "munich-hub:marienplatz",
    kind: "fixed-hub",
    label: "Marienplatz",
    coordinate: { latitude: 48.137154, longitude: 11.57549 },
    station: null,
    alternativeIdentity: null,
  },
  {
    id: "munich-hub:odeonsplatz",
    kind: "fixed-hub",
    label: "Odeonsplatz",
    coordinate: { latitude: 48.14213, longitude: 11.57638 },
    station: null,
    alternativeIdentity: null,
  },
  {
    id: "munich-hub:sendlinger-tor",
    kind: "fixed-hub",
    label: "Sendlinger Tor",
    coordinate: { latitude: 48.13333, longitude: 11.56667 },
    station: null,
    alternativeIdentity: null,
  },
] as const;

export function getMunichHubCandidates(): readonly RouteCandidate[] {
  return MUNICH_HUB_CANDIDATES.map((candidate) => ({
    ...candidate,
    coordinate: { ...candidate.coordinate },
  }));
}
