import { Rational, type RationalInput } from "./rational.ts";

export const ROUTE_FIRST_EPSG = 25832 as const;

export class ProjectedCoordinateMm {
  readonly epsg = ROUTE_FIRST_EPSG;
  readonly xMm: bigint;
  readonly yMm: bigint;

  constructor(xMm: bigint, yMm: bigint) {
    this.xMm = xMm;
    this.yMm = yMm;
    Object.freeze(this);
  }

  equals(other: ProjectedCoordinateMm): boolean {
    return this.xMm === other.xMm && this.yMm === other.yMm;
  }

  key(): string { return `${this.xMm},${this.yMm}`; }
}

function exactInteger(value: bigint | number | string, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an exact integer.`);
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`${label} must be an exact integer.`);
  return BigInt(value);
}

export function projectedCoordinateMm(
  xMm: bigint | number | string,
  yMm: bigint | number | string,
): ProjectedCoordinateMm {
  return new ProjectedCoordinateMm(exactInteger(xMm, "xMm"), exactInteger(yMm, "yMm"));
}

export function isProjectedCoordinateMm(value: unknown): value is ProjectedCoordinateMm {
  return value instanceof ProjectedCoordinateMm && value.epsg === ROUTE_FIRST_EPSG;
}

export interface ExactPoint {
  readonly x: Rational;
  readonly y: Rational;
}

export function exactPoint(x: RationalInput, y: RationalInput): ExactPoint {
  return Object.freeze({ x: Rational.from(x), y: Rational.from(y) });
}

export function pointFromCoordinate(coordinate: ProjectedCoordinateMm): ExactPoint {
  return exactPoint(coordinate.xMm, coordinate.yMm);
}

export function interpolateCoordinate(
  from: ProjectedCoordinateMm,
  to: ProjectedCoordinateMm,
  fraction: RationalInput,
): ExactPoint {
  const t = Rational.from(fraction);
  if (t.isNegative() || t.compare(1) > 0) throw new Error("Interpolation fraction must be within [0, 1].");
  return exactPoint(
    Rational.from(from.xMm).add(Rational.from(to.xMm - from.xMm).multiply(t)),
    Rational.from(from.yMm).add(Rational.from(to.yMm - from.yMm).multiply(t)),
  );
}

export function squaredDistanceMm(from: ProjectedCoordinateMm, to: ProjectedCoordinateMm): Rational {
  const dx = Rational.from(to.xMm - from.xMm);
  const dy = Rational.from(to.yMm - from.yMm);
  return dx.multiply(dx).add(dy.multiply(dy));
}

export function coordinateAtFraction(
  from: ProjectedCoordinateMm,
  to: ProjectedCoordinateMm,
  fraction: RationalInput,
): ExactPoint {
  return interpolateCoordinate(from, to, fraction);
}
