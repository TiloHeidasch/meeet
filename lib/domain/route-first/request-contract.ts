import {
  isCanonicalUtcInstant,
} from "../../domain/routing-snapshot.ts";
import { Rational } from "./rational.ts";

export type RouteFirstClientMode = "transit" | "bike" | "car";

export interface RouteFirstClientOrigin {
  readonly latitude: number;
  readonly longitude: number;
}

export interface RouteFirstClientParticipant {
  readonly participantId: string;
  readonly origin: RouteFirstClientOrigin;
  readonly mode: RouteFirstClientMode;
}

/**
 * The only route-first data accepted from a caller. Graphs, manifests,
 * journeys, profiles, topology, evidence, and policy are server assembled.
 */
export interface RouteFirstClientSubmission {
  readonly participants: readonly RouteFirstClientParticipant[];
  readonly departureAt: string;
  readonly tolerancePercent: string;
}

export const MAX_ROUTE_FIRST_CLIENT_PARTICIPANTS = 4;
export const MAX_ROUTE_FIRST_CLIENT_ID_LENGTH = 64;
export const MAX_ROUTE_FIRST_CLIENT_SUBMISSION_BYTES = 16 * 1024;

type JsonRecord = Record<string, unknown>;

function object(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error(`${path}.${key} is not accepted.`);
  }
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value;
}

function stringValue(value: unknown, path: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new Error(`${path} must be a bounded non-empty string.`);
  }
  return value;
}

function participantId(value: unknown, path: string): string {
  const id = stringValue(value, path, MAX_ROUTE_FIRST_CLIENT_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || /^(?:session|job|request)$/i.test(id)) {
    throw new Error(`${path} must be a canonical participant identifier.`);
  }
  return id;
}

function finiteCoordinate(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be a finite Munich coordinate.`);
  }
  return value;
}

function rational(value: unknown, path: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${path} must be an exact rational.`);
  let parsed: Rational;
  try {
    parsed = Rational.from(value);
  } catch (error) {
    throw new Error(`${path} is invalid: ${error instanceof Error ? error.message : "invalid rational"}`);
  }
  return parsed.toString();
}

function parseParticipant(value: unknown, path: string): RouteFirstClientParticipant {
  const source = object(value, path);
  exactKeys(source, ["participantId", "origin", "mode"], path);
  const originSource = object(source.origin, `${path}.origin`);
  exactKeys(originSource, ["latitude", "longitude"], `${path}.origin`);
  const mode = stringValue(source.mode, `${path}.mode`, 16);
  if (mode !== "transit" && mode !== "bike" && mode !== "car") throw new Error(`${path}.mode is unsupported.`);
  return {
    participantId: participantId(source.participantId, `${path}.participantId`),
    origin: {
      latitude: finiteCoordinate(originSource.latitude, `${path}.origin.latitude`, 47, 49),
      longitude: finiteCoordinate(originSource.longitude, `${path}.origin.longitude`, 10, 12),
    },
    mode,
  };
}

export function parseRouteFirstClientSubmission(value: unknown): RouteFirstClientSubmission {
  const source = object(value, "body");
  exactKeys(source, ["participants", "departureAt", "tolerancePercent"], "body");
  const participants = array(source.participants, "body.participants").map((entry, index) => parseParticipant(entry, `body.participants[${index}]`));
  if (participants.length < 2 || participants.length > MAX_ROUTE_FIRST_CLIENT_PARTICIPANTS) {
    throw new Error("Route-first submissions require 2 to 4 participants.");
  }
  const ids = participants.map((participant) => participant.participantId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    throw new Error("Participant identifiers must be sorted and unique.");
  }
  const departureAt = stringValue(source.departureAt, "body.departureAt", 40);
  if (!isCanonicalUtcInstant(departureAt)) throw new Error("body.departureAt must be a canonical UTC instant.");
  const tolerancePercent = rational(source.tolerancePercent, "body.tolerancePercent");
  const tolerance = Rational.from(tolerancePercent);
  if (tolerance.isNegative() || tolerance.compare(100) > 0) throw new Error("body.tolerancePercent must be within [0, 100].");
  return Object.freeze({
    participants: Object.freeze(participants.map((participant) => Object.freeze({ ...participant, origin: Object.freeze({ ...participant.origin }) }))),
    departureAt,
    tolerancePercent,
  });
}

/** Compatibility name retained for callers of the route-first boundary. */
export const parseRouteFirstMeetingRequestPayload = parseRouteFirstClientSubmission;

export function serializeRouteFirstClientSubmission(submission: RouteFirstClientSubmission): RouteFirstClientSubmission {
  return {
    participants: submission.participants.map((participant) => ({
      participantId: participant.participantId,
      origin: { latitude: participant.origin.latitude, longitude: participant.origin.longitude },
      mode: participant.mode,
    })),
    departureAt: submission.departureAt,
    tolerancePercent: submission.tolerancePercent,
  };
}

/** Compatibility name retained; it serializes only the minimal client DTO. */
export const serializeRouteFirstMeetingRequestPayload = serializeRouteFirstClientSubmission;

export function canonicalClientSubmissionKey(submission: RouteFirstClientSubmission): string {
  return JSON.stringify({
    participants: submission.participants.map((participant) => ({
      participantId: participant.participantId,
      origin: participant.origin,
      mode: participant.mode,
    })),
    departureAt: submission.departureAt,
    tolerancePercent: submission.tolerancePercent,
  });
}
