export interface FairLocationOrderKey {
  readonly maxDurationMilliseconds: number;
  readonly physicalIdentity: string;
}

export function fairLocationOrderKey(
  physicalIdentity: string,
  journeys: readonly { plannedDurationMilliseconds: number }[],
): FairLocationOrderKey {
  return {
    maxDurationMilliseconds: Math.max(...journeys.map((journey) => journey.plannedDurationMilliseconds)),
    physicalIdentity,
  };
}

export function compareFairLocationOrder(left: FairLocationOrderKey, right: FairLocationOrderKey): number {
  if (left.maxDurationMilliseconds < right.maxDurationMilliseconds) return -1;
  if (left.maxDurationMilliseconds > right.maxDurationMilliseconds) return 1;
  if (left.physicalIdentity < right.physicalIdentity) return -1;
  if (left.physicalIdentity > right.physicalIdentity) return 1;
  return 0;
}
