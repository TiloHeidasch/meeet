import { ROUTING_SNAPSHOT_CONTRACT_VERSION } from "./types.ts";
import type { RoutingSnapshot, RoutingSnapshotApplicationState } from "./types.ts";

export const MAX_ROUTING_SNAPSHOT_STRING_LENGTH = 512;
export const MAX_ROUTING_SNAPSHOT_FEEDS = 2;
export const ROUTING_ACCESS_ENVELOPE_EXTENT_KM = 15 as const;
const DIGEST_QUALIFIED_IMAGE = /^[^@\s]+@sha256:[a-f0-9]{64}$/;
const CANONICAL_UTC_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

export interface RoutingSnapshotValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type SafeRoutingSnapshot =
  | { success: true; data: RoutingSnapshot }
  | { success: false; issues: readonly RoutingSnapshotValidationIssue[] };

export function validateRoutingSnapshot(value: unknown): SafeRoutingSnapshot {
  const issues: RoutingSnapshotValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid(issue([], "invalid_type", "Routing manifest must be an object."));
  }
  requireKeys(value, [
    "contractVersion",
    "engine",
    "manifestId",
    "generatedAt",
    "engines",
    "profiles",
    "feeds",
    "osm",
    "config",
    "artifacts",
    "officialBoundary",
    "accessEnvelope",
    "realtime",
  ], [], issues);
  if (value.contractVersion !== ROUTING_SNAPSHOT_CONTRACT_VERSION) {
    issues.push(issue(["contractVersion"], "invalid_value", "Unknown routing manifest contract version."));
  }
  if (value.engine !== "otp-graphhopper") {
    issues.push(issue(["engine"], "invalid_value", "Routing manifest engine must be otp-graphhopper."));
  }
  validateString(value.manifestId, ["manifestId"], issues, 1);
  validateIsoInstant(value.generatedAt, ["generatedAt"], issues);
  validateEngine(value.engines, ["engines"], issues);
  validateProfiles(value.profiles, ["profiles"], issues);
  validateFeeds(value.feeds, ["feeds"], issues);
  validateOsm(value.osm, ["osm"], issues);
  validateConfig(value.config, ["config"], issues);
  validateArtifacts(value.artifacts, ["artifacts"], issues);
  validateArtifact(value.officialBoundary, ["officialBoundary"], issues);
  validateAccessEnvelope(value.accessEnvelope, ["accessEnvelope"], issues);
  validateRealtime(value.realtime, ["realtime"], issues);

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, data: value as unknown as RoutingSnapshot };
}

export function parseRoutingSnapshot(value: unknown): RoutingSnapshot | null {
  const result = validateRoutingSnapshot(value);
  return result.success ? result.data : null;
}

export const validateRoutingManifest = validateRoutingSnapshot;
export const parseRoutingManifest = parseRoutingSnapshot;

export function assertRoutingSnapshot(value: unknown): RoutingSnapshot {
  const result = validateRoutingSnapshot(value);
  if (!result.success) throw new Error("Routing manifest failed strict validation.");
  return result.data;
}

export function isCanonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CANONICAL_UTC_INSTANT.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  return new Date(timestamp).toISOString() === `${match[1]}.${fraction}Z`;
}

/**
 * The generated manifest deliberately has no second, operator-editable
 * application-provenance object. These states are the only application
 * interpretation permitted for the canonical feed/realtime fields.
 */
export function getRoutingSnapshotApplicationState(
  snapshot: RoutingSnapshot,
): RoutingSnapshotApplicationState {
  const mvv = snapshot.feeds.find((feed) => feed.name === "MVV");
  const mvg = snapshot.feeds.find((feed) => feed.name === "MVG");
  if (
    !mvv ||
    !mvg ||
    mvv.role !== "authoritative-schedule" ||
    mvg.role !== "metadata-enrichment"
  ) {
    throw new Error("Canonical routing manifest is missing MVV or MVG.");
  }
  return {
    mvv: { role: mvv.role, applied: true },
    mvg: { role: mvg.role, applied: false },
    realtime: {
      state: snapshot.realtime.state,
      dataState: snapshot.realtime.dataState,
      applied: false,
    },
  };
}

export const assertRoutingManifest = assertRoutingSnapshot;

function validateEngine(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Engine identities are required."));
    return;
  }
  requireKeys(value, ["otp", "graphhopper"], path, issues);
  validateEngineImage(value.otp, path.concat("otp"), issues);
  validateEngineImage(value.graphhopper, path.concat("graphhopper"), issues);
}

function validateEngineImage(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Engine image identity is required."));
    return;
  }
  requireKeys(value, ["id", "contentHash", "image", "digest", "version"], path, issues);
  validateString(value.id, path.concat("id"), issues, 1);
  validateHash(value.contentHash, path.concat("contentHash"), issues);
  if (typeof value.image !== "string" || !DIGEST_QUALIFIED_IMAGE.test(value.image)) {
    issues.push(issue(path.concat("image"), "invalid_image", "Engine images must be digest-qualified references."));
  }
  if (typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
    issues.push(issue(path.concat("digest"), "invalid_digest", "Engine image digest must be sha256 plus 64 lowercase hex characters."));
  }
  if (
    typeof value.image === "string" &&
    typeof value.digest === "string" &&
    DIGEST_QUALIFIED_IMAGE.test(value.image) &&
    value.image.split("@")[1] !== value.digest
  ) {
    issues.push(issue(path.concat("digest"), "mismatch", "Engine image and digest must agree."));
  }
  if (
    typeof value.contentHash === "string" &&
    typeof value.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.digest) &&
    value.contentHash !== value.digest.slice("sha256:".length)
  ) {
    issues.push(issue(path.concat("contentHash"), "mismatch", "Engine content hash and digest must agree."));
  }
  validateString(value.version, path.concat("version"), issues, 1);
}

function validateProfiles(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Routing profiles are required."));
    return;
  }
  requireKeys(value, ["otp", "bike", "car"], path, issues);
  validateString(value.otp, path.concat("otp"), issues, 1);
  validateString(value.bike, path.concat("bike"), issues, 1);
  validateString(value.car, path.concat("car"), issues, 1);
}

function validateFeeds(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length !== MAX_ROUTING_SNAPSHOT_FEEDS) {
    issues.push(issue(path, "invalid_length", "Routing manifests require exactly MVV and MVG feed records."));
    return;
  }
  const names = new Set<string>();
  const roles = new Set<string>();
  value.forEach((feed, index) => {
    const feedPath = path.concat(index);
    if (!isRecord(feed)) {
      issues.push(issue(feedPath, "invalid_type", "Routing feed must be an object."));
      return;
    }
    requireKeys(feed, ["name", "sourceUrl", "license", "attribution", "version", "retrievedAt", "feedId", "contentHash", "asOf", "role"], feedPath, issues);
    if (feed.name !== "MVG" && feed.name !== "MVV") issues.push(issue(feedPath.concat("name"), "invalid_value", "Routing feed must be MVG or MVV."));
    if (feed.role !== "authoritative-schedule" && feed.role !== "metadata-enrichment") {
      issues.push(issue(feedPath.concat("role"), "invalid_value", "Routing feed role is invalid."));
    }
    if (feed.name === "MVV" && feed.role !== "authoritative-schedule") issues.push(issue(feedPath.concat("role"), "invalid_role", "MVV must be the authoritative schedule feed."));
    if (feed.name === "MVG" && feed.role !== "metadata-enrichment") issues.push(issue(feedPath.concat("role"), "invalid_role", "MVG must be metadata enrichment."));
    if (typeof feed.name === "string") {
      if (names.has(feed.name)) issues.push(issue(feedPath.concat("name"), "duplicate", "Feed names must be unique."));
      names.add(feed.name);
    }
    if (typeof feed.role === "string") {
      if (roles.has(feed.role)) issues.push(issue(feedPath.concat("role"), "duplicate", "Feed roles must be unique."));
      roles.add(feed.role);
    }
    validateHttpsUrl(feed.sourceUrl, feedPath.concat("sourceUrl"), issues);
    validateLicense(feed.license, feedPath.concat("license"), issues);
    validateString(feed.attribution, feedPath.concat("attribution"), issues, 1);
    validateString(feed.version, feedPath.concat("version"), issues, 1);
    validateIsoInstant(feed.retrievedAt, feedPath.concat("retrievedAt"), issues);
    validateString(feed.feedId, feedPath.concat("feedId"), issues, 1);
    validateHash(feed.contentHash, feedPath.concat("contentHash"), issues);
    validateIsoInstant(feed.asOf, feedPath.concat("asOf"), issues);
  });
}

function validateOsm(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "OSM provenance is required."));
    return;
  }
  requireKeys(value, ["id", "contentHash", "sourceUrl", "license", "attribution", "version", "retrievedAt", "asOf"], path, issues);
  validateString(value.id, path.concat("id"), issues, 1);
  validateHash(value.contentHash, path.concat("contentHash"), issues);
  validateHttpsUrl(value.sourceUrl, path.concat("sourceUrl"), issues);
  validateLicense(value.license, path.concat("license"), issues);
  validateString(value.attribution, path.concat("attribution"), issues, 1);
  validateString(value.version, path.concat("version"), issues, 1);
  validateIsoInstant(value.retrievedAt, path.concat("retrievedAt"), issues);
  validateIsoInstant(value.asOf, path.concat("asOf"), issues);
}

function validateConfig(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Routing configuration provenance is required."));
    return;
  }
  requireKeys(value, ["id", "contentHash", "asOf"], path, issues);
  validateString(value.id, path.concat("id"), issues, 1);
  validateHash(value.contentHash, path.concat("contentHash"), issues);
  validateIsoInstant(value.asOf, path.concat("asOf"), issues);
}

function validateArtifacts(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Graph and input artifact identities are required."));
    return;
  }
  requireKeys(value, ["graph", "input"], path, issues);
  validateArtifact(value.graph, path.concat("graph"), issues);
  validateArtifact(value.input, path.concat("input"), issues);
}

function validateArtifact(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Artifact identity is required."));
    return;
  }
  requireKeys(value, ["id", "contentHash"], path, issues);
  validateString(value.id, path.concat("id"), issues, 1);
  validateHash(value.contentHash, path.concat("contentHash"), issues);
}

function validateAccessEnvelope(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Munich access-envelope provenance is required."));
    return;
  }
  requireKeys(value, ["artifact", "extentKm", "bounds"], path, issues);
  validateArtifact(value.artifact, path.concat("artifact"), issues);
  if (value.extentKm !== ROUTING_ACCESS_ENVELOPE_EXTENT_KM) {
    issues.push(issue(path.concat("extentKm"), "invalid_value", "The routing access envelope must be 15 km."));
  }
  if (!isRecord(value.bounds)) {
    issues.push(issue(path.concat("bounds"), "invalid_type", "Access-envelope bounds are required."));
    return;
  }
  requireKeys(value.bounds, ["minLatitude", "maxLatitude", "minLongitude", "maxLongitude"], path.concat("bounds"), issues);
  const minLatitude = finiteNumber(value.bounds.minLatitude, path.concat("bounds", "minLatitude"), issues);
  const maxLatitude = finiteNumber(value.bounds.maxLatitude, path.concat("bounds", "maxLatitude"), issues);
  const minLongitude = finiteNumber(value.bounds.minLongitude, path.concat("bounds", "minLongitude"), issues);
  const maxLongitude = finiteNumber(value.bounds.maxLongitude, path.concat("bounds", "maxLongitude"), issues);
  if (minLatitude !== null && maxLatitude !== null && (minLatitude < -90 || maxLatitude > 90 || minLatitude >= maxLatitude)) issues.push(issue(path.concat("bounds"), "invalid_bounds", "Latitude bounds are invalid."));
  if (minLongitude !== null && maxLongitude !== null && (minLongitude < -180 || maxLongitude > 180 || minLongitude >= maxLongitude)) issues.push(issue(path.concat("bounds"), "invalid_bounds", "Longitude bounds are invalid."));
}

function validateRealtime(
  value: unknown,
  path: Array<string | number>,
  issues: RoutingSnapshotValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "Frozen realtime provenance is required."));
    return;
  }
  requireKeys(value, ["state", "dataState", "artifact", "timestamp"], path, issues);
  if (value.state !== "frozen") issues.push(issue(path.concat("state"), "invalid_value", "Realtime artifact state must be frozen."));
  if (value.dataState !== "scheduled" && value.dataState !== "live" && value.dataState !== "unknown") issues.push(issue(path.concat("dataState"), "invalid_value", "Realtime data state is invalid."));
  validateArtifact(value.artifact, path.concat("artifact"), issues);
  if (value.timestamp !== null) validateIsoInstant(value.timestamp, path.concat("timestamp"), issues);
  if (value.dataState === "live" && value.timestamp === null) issues.push(issue(path.concat("timestamp"), "missing_field", "Live frozen realtime data requires a timestamp."));
  if (value.dataState !== "live" && value.timestamp !== null) issues.push(issue(path.concat("timestamp"), "invalid_value", "Only live frozen data may carry a timestamp."));
}

function validateLicense(value: unknown, path: Array<string | number>, issues: RoutingSnapshotValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid_type", "A source licence is required."));
    return;
  }
  requireKeys(value, ["name", "url"], path, issues);
  validateString(value.name, path.concat("name"), issues, 1);
  validateHttpsUrl(value.url, path.concat("url"), issues);
}

function validateHttpsUrl(value: unknown, path: Array<string | number>, issues: RoutingSnapshotValidationIssue[]): void {
  if (typeof value !== "string" || !value.startsWith("https://") || value.length > MAX_ROUTING_SNAPSHOT_STRING_LENGTH) issues.push(issue(path, "invalid_url", "URL must be an HTTPS URL."));
}

function validateHash(value: unknown, path: Array<string | number>, issues: RoutingSnapshotValidationIssue[]): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) issues.push(issue(path, "invalid_hash", "Content hashes must be lowercase SHA-256 hex strings."));
}

function finiteNumber(value: unknown, path: Array<string | number>, issues: RoutingSnapshotValidationIssue[]): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(issue(path, "invalid_number", "Value must be a finite number."));
    return null;
  }
  return value;
}

function validateIsoInstant(value: unknown, path: Array<string | number>, issues: RoutingSnapshotValidationIssue[]): void {
  if (!isCanonicalUtcInstant(value)) issues.push(issue(path, "invalid_datetime", "Timestamp must be a canonical UTC ISO instant."));
}

function validateString(value: unknown, path: Array<string | number>, issues: RoutingSnapshotValidationIssue[], minimum: number): void {
  if (typeof value !== "string" || value.length < minimum || value.length > MAX_ROUTING_SNAPSHOT_STRING_LENGTH) issues.push(issue(path, "invalid_string", "String is missing or outside the allowed size."));
}

function requireKeys(value: Record<string, unknown>, required: readonly string[], path: Array<string | number>, issues: RoutingSnapshotValidationIssue[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  required.forEach((key) => { if (!(key in value)) issues.push(issue(path.concat(key), "missing_field", `Missing ${key}.`)); });
  Object.keys(value).forEach((key) => { if (!allowed.has(key)) issues.push(issue(path.concat(key), "unknown_field", `Unknown field ${key}.`)); });
}

function issue(path: Array<string | number>, code: string, message: string): RoutingSnapshotValidationIssue {
  return { path, code, message };
}

function invalid(singleIssue: RoutingSnapshotValidationIssue): SafeRoutingSnapshot {
  return { success: false, issues: [singleIssue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
