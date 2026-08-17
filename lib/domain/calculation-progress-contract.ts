export const CALCULATION_PROGRESS_CONTRACT_VERSION = "meeet-calculation-progress/v1";

export const CALCULATION_PROGRESS_PHASES = [
  "access-seeds",
  "scheduled-routing",
  "station-area-evaluation",
  "validating-result",
] as const;

export type CalculationProgressPhase = (typeof CALCULATION_PROGRESS_PHASES)[number];

export type StationVerdict = {
  readonly stationAreaId: string;
  readonly name: string;
  readonly coordinate: { readonly latitude: number; readonly longitude: number };
  readonly verdict: "red" | "blue" | "fair" | "unclassified";
  readonly mode?: "sbahn" | "ubahn" | "tram" | "bus";
};
