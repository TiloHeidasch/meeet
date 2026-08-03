/** Exact arbitrary-precision rational arithmetic for route-domain proofs. */
export type RationalInput = Rational | bigint | number | string;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;
  while (b !== BigInt(0)) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === BigInt(0) ? BigInt(1) : a;
}

function parseDecimal(value: string): [bigint, bigint] {
  if (/^[+-]?\d+$/.test(value)) return [BigInt(value), BigInt(1)];
  const fraction = /^([+-]?)(\d*)\.(\d+)(?:[eE]([+-]?\d+))?$/.exec(value);
  if (fraction) {
    const sign = fraction[1] === "-" ? BigInt(-1) : BigInt(1);
    const whole = fraction[2] || "0";
    const digits = `${whole}${fraction[3]}`;
    const exponent = Number(fraction[4] ?? 0);
    const scale = fraction[3].length - exponent;
    if (scale >= 0) return [sign * BigInt(digits), BigInt(10) ** BigInt(scale)];
    return [sign * BigInt(digits) * BigInt(10) ** BigInt(-scale), BigInt(1)];
  }
  const scientific = /^([+-]?\d+)(?:[eE]([+-]?\d+))$/.exec(value);
  if (scientific) {
    const exponent = Number(scientific[2]);
    if (exponent >= 0) return [BigInt(scientific[1]) * BigInt(10) ** BigInt(exponent), BigInt(1)];
    return [BigInt(scientific[1]), BigInt(10) ** BigInt(-exponent)];
  }
  throw new Error(`Invalid exact rational: ${value}`);
}

function parseInput(value: RationalInput): [bigint, bigint] {
  if (value instanceof Rational) return [value.numerator, value.denominator];
  if (typeof value === "bigint") return [value, BigInt(1)];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Rational numbers must be finite.");
    return parseDecimal(value.toString());
  }
  if (/^[+-]?\d+\/[1-9]\d*$/.test(value)) {
    const [numerator, denominator] = value.split("/");
    return [BigInt(numerator), BigInt(denominator)];
  }
  return parseDecimal(value);
}

export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    if (denominator === BigInt(0)) throw new Error("Rational denominator cannot be zero.");
    const sign = denominator < BigInt(0) ? BigInt(-1) : BigInt(1);
    const divisor = gcd(numerator, denominator);
    this.numerator = sign * numerator / divisor;
    this.denominator = sign * denominator / divisor;
    Object.freeze(this);
  }

  static from(value: RationalInput): Rational {
    const [numerator, denominator] = parseInput(value);
    return new Rational(numerator, denominator);
  }

  static zero(): Rational { return new Rational(BigInt(0), BigInt(1)); }
  static one(): Rational { return new Rational(BigInt(1), BigInt(1)); }

  add(other: RationalInput): Rational {
    const value = Rational.from(other);
    return new Rational(
      this.numerator * value.denominator + value.numerator * this.denominator,
      this.denominator * value.denominator,
    );
  }

  subtract(other: RationalInput): Rational { return this.add(Rational.from(other).negate()); }

  multiply(other: RationalInput): Rational {
    const value = Rational.from(other);
    return new Rational(this.numerator * value.numerator, this.denominator * value.denominator);
  }

  divide(other: RationalInput): Rational {
    const value = Rational.from(other);
    if (value.numerator === BigInt(0)) throw new Error("Cannot divide a rational by zero.");
    return new Rational(this.numerator * value.denominator, this.denominator * value.numerator);
  }

  negate(): Rational { return new Rational(-this.numerator, this.denominator); }
  abs(): Rational { return this.numerator < BigInt(0) ? this.negate() : this; }
  compare(other: RationalInput): -1 | 0 | 1 {
    const value = Rational.from(other);
    const difference = this.numerator * value.denominator - value.numerator * this.denominator;
    return difference < BigInt(0) ? -1 : difference > BigInt(0) ? 1 : 0;
  }
  equals(other: RationalInput): boolean { return this.compare(other) === 0; }
  isZero(): boolean { return this.numerator === BigInt(0); }
  isPositive(): boolean { return this.numerator > BigInt(0); }
  isNegative(): boolean { return this.numerator < BigInt(0); }

  floor(): bigint {
    if (this.numerator >= BigInt(0)) return this.numerator / this.denominator;
    return -((-this.numerator + this.denominator - BigInt(1)) / this.denominator);
  }

  ceil(): bigint {
    if (this.numerator >= BigInt(0)) return (this.numerator + this.denominator - BigInt(1)) / this.denominator;
    return -((-this.numerator) / this.denominator);
  }

  toNumber(): number { return Number(this.numerator) / Number(this.denominator); }
  toString(): string { return this.denominator === BigInt(1) ? `${this.numerator}` : `${this.numerator}/${this.denominator}`; }
  toJSON(): string { return this.toString(); }
}

export function rational(value: RationalInput): Rational { return Rational.from(value); }

export function rationalMin(values: readonly Rational[]): Rational {
  if (values.length === 0) throw new Error("Cannot take the minimum of an empty rational list.");
  return values.slice(1).reduce((current, value) => value.compare(current) < 0 ? value : current, values[0]!);
}

export function rationalMax(values: readonly Rational[]): Rational {
  if (values.length === 0) throw new Error("Cannot take the maximum of an empty rational list.");
  return values.slice(1).reduce((current, value) => value.compare(current) > 0 ? value : current, values[0]!);
}

export function rationalSum(values: readonly Rational[]): Rational {
  return values.reduce((total, value) => total.add(value), Rational.zero());
}
