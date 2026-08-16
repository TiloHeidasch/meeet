import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  FeedProvenance,
  GeoJsonGeometry,
  GeoJsonPosition,
  ProviderDeploymentKind,
  RoutingArtifactIdentity,
  RoutingEngineSnapshot,
  RoutingSnapshot,
  RoutingSnapshotApplicationState,
  SourceLicense,
} from "../domain/types.ts";
import {
  assertRoutingSnapshot,
  getRoutingSnapshotApplicationState,
} from "../domain/routing-snapshot.ts";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 4_000;
export const MIN_PROVIDER_TIMEOUT_MS = 250;
export const MAX_PROVIDER_TIMEOUT_MS = 10_000;
export const DEFAULT_PROVIDER_MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SCHEDULED_CONCURRENCY = 1;
export const MIN_SCHEDULED_CONCURRENCY = 1;
export const MAX_SCHEDULED_CONCURRENCY = 1;
export const DEFAULT_SCHEDULED_DEADLINE_MS = 30_000;
export const MIN_SCHEDULED_DEADLINE_MS = 30_000;
export const MAX_SCHEDULED_DEADLINE_MS = 30_000;
export const DEFAULT_SCHEDULED_MIN_MEMORY_GIB = 4;
export const MIN_SCHEDULED_MIN_MEMORY_GIB = 4;
const ROUTING_MANIFEST_FILENAME = "meeet-routing-manifest.json";
const ROUTING_ATTESTATION_FILENAME = "deployment-attestation.json";
const ACCESS_ENVELOPE_FILENAME = "munich-access-envelope-15km.geojson";

export type ProviderMode = "fixture" | "configured";
export type RoutingProviderMode = ProviderMode | "self-hosted-routing";

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export type ScheduledCapabilityUnavailableReason = "schedule-artifact-not-configured";
export interface ScheduledCapability {
  readonly scheduled: {
    readonly configurationAvailable: boolean;
    readonly unavailableReason: ScheduledCapabilityUnavailableReason | null;
  };
}

/**
 * Pure capability disclosure. It intentionally reads only allow-listed mode and
 * path settings; it never reads an artifact, validates a manifest, or creates a
 * provider.
 */
export function readScheduledCapability(
  env: ProviderEnvironment = process.env,
): ScheduledCapability {
  const mode = env.MEEET_PROVIDER_MODE?.trim() || "configured";
  const configurationAvailable = mode === "fixture" ||
    ((mode === "configured" || mode === "self-hosted-routing") && Boolean(env.MEEET_SCHEDULE_ARTIFACT_PATH?.trim()));
  return {
    scheduled: {
      configurationAvailable,
      unavailableReason: configurationAvailable ? null : "schedule-artifact-not-configured",
    },
  };
}

export const getScheduledCapability = readScheduledCapability;

export interface ProviderConfig {
  mode: RoutingProviderMode;
  routingGatewayUrl: string | null;
  routingGatewayToken: string | null;
  geocodingUrl: string | null;
  geocodingToken: string | null;
  poiUrl: string | null;
  poiToken: string | null;
  deployment: ProviderDeploymentKind;
  timeoutMs: number;
  maxResponseBytes: number;
  routingFeeds: {
    mvg: FeedProvenance;
    mvv: FeedProvenance;
  } | null;
  allowHttpProviderEndpoints: boolean;
  mapStyleUrl: string | null;
  mapAttribution: string | null;
  geocodingSource: ConfiguredSourceMetadata | null;
  poiSource: ConfiguredSourceMetadata | null;
  selfHostedRouting: SelfHostedRoutingConfig | null;
  scheduledArtifactPath: string | null;
  scheduledConcurrency: number;
  scheduledDeadlineMs: number;
  scheduledMinMemoryGiB: number;
}

export interface SelfHostedRoutingConfig {
  timeoutMs: number;
  maxResponseBytes: number;
  manifestPath: string;
  otpGraphqlUrl: string;
  otpToken: string | null;
  otpProfile: string;
  graphhopperUrl: string;
  graphhopperToken: string | null;
  graphhopperBikeProfile: string;
  graphhopperCarProfile: string;
  snapshot: RoutingSnapshot;
  engineSnapshots: {
    otp: RoutingEngineSnapshot;
    graphhopper: RoutingEngineSnapshot;
  };
  accessEnvelopeGeometry: GeoJsonGeometry;
  applicationState: RoutingSnapshotApplicationState;
}

export interface ConfiguredSourceMetadata {
  name: string;
  url: string;
  license: SourceLicense;
  attribution: string;
  version: string;
  retrievedAt: string;
}

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export function readProviderConfig(
  env: ProviderEnvironment = process.env,
): ProviderConfig {
  const allowHttpProviderEndpoints =
    env.MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS === "true" &&
    env.NODE_ENV === "development";
  const requestedMode = env.MEEET_PROVIDER_MODE?.trim();
  if (
    requestedMode &&
    requestedMode !== "fixture" &&
    requestedMode !== "configured" &&
    requestedMode !== "self-hosted-routing"
  ) {
    throw new ProviderConfigurationError(
      "MEEET_PROVIDER_MODE must be fixture, configured, or self-hosted-routing.",
    );
  }
  const hasSelfHostedRoutingSettings = hasAnySelfHostedRoutingSetting(env);
  if (hasSelfHostedRoutingSettings && requestedMode !== "self-hosted-routing") {
    throw new ProviderConfigurationError(
      "Self-hosted OTP/GraphHopper settings require MEEET_PROVIDER_MODE=self-hosted-routing.",
    );
  }

  const endpoints = {
    routingGatewayUrl: readOptionalUrl(
      env.MEEET_ROUTING_GATEWAY_URL,
      "MEEET_ROUTING_GATEWAY_URL",
      allowHttpProviderEndpoints,
    ),
    geocodingUrl: readOptionalUrl(
      env.MEEET_GEOCODING_ENDPOINT,
      "MEEET_GEOCODING_ENDPOINT",
      allowHttpProviderEndpoints,
    ),
    poiUrl: readOptionalUrl(
      env.MEEET_POI_ENDPOINT,
      "MEEET_POI_ENDPOINT",
      allowHttpProviderEndpoints,
    ),
  };
  const hasConfiguredEndpoint = Object.values(endpoints).some(Boolean);
  const mode: RoutingProviderMode = requestedMode === "fixture"
    ? "fixture"
    : requestedMode === "self-hosted-routing"
    ? "self-hosted-routing"
    : "configured";
  const deployment = readDeployment(env.MEEET_PROVIDER_DEPLOYMENT);
  if (requestedMode === "fixture" && (hasConfiguredEndpoint || hasSelfHostedRoutingSettings)) {
    throw new ProviderConfigurationError(
      "MEEET_PROVIDER_MODE=fixture cannot be combined with configured provider endpoints or self-hosted routing settings.",
    );
  }
  if (mode === "configured" && deployment === "fixture") {
    throw new ProviderConfigurationError(
      "Configured provider mode cannot use fixture deployment metadata.",
    );
  }
  if (mode === "self-hosted-routing") {
    if (deployment !== "self-hosted") {
      throw new ProviderConfigurationError(
        "MEEET_PROVIDER_MODE=self-hosted-routing requires MEEET_PROVIDER_DEPLOYMENT=self-hosted.",
      );
    }
    if (endpoints.routingGatewayUrl || env.MEEET_ROUTING_GATEWAY_TOKEN?.trim()) {
      throw new ProviderConfigurationError(
        "self-hosted-routing cannot be combined with MEEET_ROUTING_GATEWAY_URL or MEEET_ROUTING_GATEWAY_TOKEN.",
      );
    }
    rejectSelfHostedOperatorProvenance(env);
  }
  const routingFeeds = endpoints.routingGatewayUrl
    ? {
        mvg: readFeedProvenance(env, "MEEET_ROUTING_MVG", "MVG"),
        mvv: readFeedProvenance(env, "MEEET_ROUTING_MVV", "MVV"),
      }
    : null;
  const geocodingSource = endpoints.geocodingUrl
    ? readConfiguredSourceMetadata(env, "MEEET_GEOCODING")
    : null;
  const poiSource = endpoints.poiUrl
    ? readConfiguredSourceMetadata(env, "MEEET_POI")
    : null;
  const selfHostedRouting = mode === "self-hosted-routing"
    ? readSelfHostedRoutingConfig(env)
    : null;

  return {
    mode,
    ...endpoints,
    routingGatewayToken:
      mode === "self-hosted-routing"
        ? null
        : readOptionalSecret(env.MEEET_ROUTING_GATEWAY_TOKEN),
    geocodingToken: readOptionalSecret(env.MEEET_GEOCODING_TOKEN),
    poiToken: readOptionalSecret(env.MEEET_POI_TOKEN),
    deployment,
    timeoutMs: readBoundedInteger(
      env.MEEET_PROVIDER_TIMEOUT_MS,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      MIN_PROVIDER_TIMEOUT_MS,
      MAX_PROVIDER_TIMEOUT_MS,
      "MEEET_PROVIDER_TIMEOUT_MS",
    ),
    maxResponseBytes: readBoundedInteger(
      env.MEEET_PROVIDER_MAX_RESPONSE_BYTES,
      DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
      16 * 1024,
      MAX_PROVIDER_MAX_RESPONSE_BYTES,
      "MEEET_PROVIDER_MAX_RESPONSE_BYTES",
    ),
    routingFeeds,
    allowHttpProviderEndpoints,
    mapStyleUrl: readOptionalUrl(
      env.NEXT_PUBLIC_MAP_STYLE_URL,
      "NEXT_PUBLIC_MAP_STYLE_URL",
      allowHttpProviderEndpoints,
    ),
    mapAttribution: readOptionalString(env.NEXT_PUBLIC_MAP_ATTRIBUTION),
    geocodingSource,
    poiSource,
    selfHostedRouting,
    scheduledArtifactPath: readOptionalScheduledArtifactPath(env.MEEET_SCHEDULE_ARTIFACT_PATH),
    scheduledConcurrency: readScheduledConcurrency(env.MEEET_SCHEDULED_CONCURRENCY),
    scheduledDeadlineMs: readScheduledDeadline(env.MEEET_SCHEDULED_DEADLINE_MS),
    scheduledMinMemoryGiB: readScheduledMinMemoryGiB(env.MEEET_SCHEDULED_MIN_MEMORY_GIB),
  };
}

function readScheduledConcurrency(value: string | undefined): number {
  return readBoundedInteger(
    value,
    DEFAULT_SCHEDULED_CONCURRENCY,
    MIN_SCHEDULED_CONCURRENCY,
    MAX_SCHEDULED_CONCURRENCY,
    "MEEET_SCHEDULED_CONCURRENCY",
  );
}

function readScheduledDeadline(value: string | undefined): number {
  return readBoundedInteger(
    value,
    DEFAULT_SCHEDULED_DEADLINE_MS,
    MIN_SCHEDULED_DEADLINE_MS,
    MAX_SCHEDULED_DEADLINE_MS,
    "MEEET_SCHEDULED_DEADLINE_MS",
  );
}

function readScheduledMinMemoryGiB(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_SCHEDULED_MIN_MEMORY_GIB;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < MIN_SCHEDULED_MIN_MEMORY_GIB) {
    throw new ProviderConfigurationError(
      `MEEET_SCHEDULED_MIN_MEMORY_GIB must be a finite numeric capacity of at least ${MIN_SCHEDULED_MIN_MEMORY_GIB} GiB.`,
    );
  }
  return parsed;
}

function readOptionalScheduledArtifactPath(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  if (!isAbsolute(value.trim())) throw new ProviderConfigurationError("MEEET_SCHEDULE_ARTIFACT_PATH must be absolute.");
  return resolve(value.trim());
}

const SELF_HOSTED_ROUTING_KEYS = [
  "MEEET_OTP_GRAPHQL_URL",
  "MEEET_OTP_TOKEN",
  "MEEET_OTP_PROFILE",
  "MEEET_GRAPHHOPPER_URL",
  "MEEET_GRAPHHOPPER_TOKEN",
  "MEEET_GRAPHHOPPER_BIKE_PROFILE",
  "MEEET_GRAPHHOPPER_CAR_PROFILE",
  "MEEET_ROUTING_MANIFEST_PATH",
] as const;

function hasAnySelfHostedRoutingSetting(env: ProviderEnvironment): boolean {
  return SELF_HOSTED_ROUTING_KEYS.some((key) => Boolean(env[key]?.trim()));
}

function readSelfHostedRoutingConfig(env: ProviderEnvironment): SelfHostedRoutingConfig {
  const manifestPath = readRequiredManifestPath(env.MEEET_ROUTING_MANIFEST_PATH);
  const otpProfile = readRequiredProfile(env.MEEET_OTP_PROFILE, "MEEET_OTP_PROFILE");
  const graphhopperBikeProfile = readRequiredProfile(
    env.MEEET_GRAPHHOPPER_BIKE_PROFILE,
    "MEEET_GRAPHHOPPER_BIKE_PROFILE",
  );
  const graphhopperCarProfile = readRequiredProfile(
    env.MEEET_GRAPHHOPPER_CAR_PROFILE,
    "MEEET_GRAPHHOPPER_CAR_PROFILE",
  );
  const loadedManifest = loadRoutingManifest(manifestPath);
  const snapshot = loadedManifest.snapshot;
  if (
    snapshot.profiles.otp !== otpProfile ||
    snapshot.profiles.bike !== graphhopperBikeProfile ||
    snapshot.profiles.car !== graphhopperCarProfile
  ) {
    throw new ProviderConfigurationError(
      "Self-hosted routing profiles must match the loaded immutable routing manifest.",
    );
  }
  return {
    timeoutMs: readBoundedInteger(
      env.MEEET_PROVIDER_TIMEOUT_MS,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      MIN_PROVIDER_TIMEOUT_MS,
      MAX_PROVIDER_TIMEOUT_MS,
      "MEEET_PROVIDER_TIMEOUT_MS",
    ),
    maxResponseBytes: readBoundedInteger(
      env.MEEET_PROVIDER_MAX_RESPONSE_BYTES,
      DEFAULT_PROVIDER_MAX_RESPONSE_BYTES,
      16 * 1024,
      MAX_PROVIDER_MAX_RESPONSE_BYTES,
      "MEEET_PROVIDER_MAX_RESPONSE_BYTES",
    ),
    manifestPath,
    otpGraphqlUrl: readRequiredEndpointUrl(
      env.MEEET_OTP_GRAPHQL_URL,
      "MEEET_OTP_GRAPHQL_URL",
      "/otp/gtfs/v1",
      env.MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS === "true" && env.NODE_ENV === "development",
    ),
    otpToken: readOptionalSecret(env.MEEET_OTP_TOKEN),
    otpProfile,
    graphhopperUrl: readRequiredEndpointUrl(
      env.MEEET_GRAPHHOPPER_URL,
      "MEEET_GRAPHHOPPER_URL",
      "/route",
      env.MEEET_ALLOW_HTTP_PROVIDER_ENDPOINTS === "true" && env.NODE_ENV === "development",
    ),
    graphhopperToken: readOptionalSecret(env.MEEET_GRAPHHOPPER_TOKEN),
    graphhopperBikeProfile,
    graphhopperCarProfile,
    snapshot,
    engineSnapshots: loadedManifest.engineSnapshots,
    accessEnvelopeGeometry: loadedManifest.accessEnvelopeGeometry,
    applicationState: getRoutingSnapshotApplicationState(snapshot),
  };
}

interface LoadedRoutingManifest {
  snapshot: RoutingSnapshot;
  engineSnapshots: {
    otp: RoutingEngineSnapshot;
    graphhopper: RoutingEngineSnapshot;
  };
  accessEnvelopeGeometry: GeoJsonGeometry;
}

function loadRoutingManifest(manifestPath: string): LoadedRoutingManifest {
  let manifestBytes: string;
  let parsed: unknown;
  try {
    manifestBytes = readFileSync(/* turbopackIgnore: true */ manifestPath, "utf8");
    parsed = JSON.parse(manifestBytes) as unknown;
  } catch {
    throw new ProviderConfigurationError("MEEET_ROUTING_MANIFEST_PATH must point to valid JSON.");
  }
  let snapshot: RoutingSnapshot;
  try {
    snapshot = assertRoutingSnapshot(parsed);
  } catch {
    throw new ProviderConfigurationError("The loaded routing manifest failed strict validation.");
  }
  const attestationPath = resolve(
    /* turbopackIgnore: true */ dirname(manifestPath),
    ROUTING_ATTESTATION_FILENAME,
  );
  let attestation: unknown;
  try {
    attestation = JSON.parse(readFileSync(/* turbopackIgnore: true */ attestationPath, "utf8")) as unknown;
  } catch {
    throw new ProviderConfigurationError(
      "The generated routing manifest requires its adjacent deployment attestation.",
    );
  }
  return {
    snapshot,
    engineSnapshots: loadEngineSnapshots(snapshot, attestation),
    accessEnvelopeGeometry: loadAttestedAccessEnvelope(
      manifestBytes,
      snapshot,
      attestation,
      manifestPath,
    ),
  };
}

function loadEngineSnapshots(
  snapshot: RoutingSnapshot,
  value: unknown,
): LoadedRoutingManifest["engineSnapshots"] {
  if (!isRecord(value) || !isRecord(value.artifacts) ||
    !isRecord(value.artifacts.otpGraph) || !isRecord(value.artifacts.graphhopper)) {
    throw new ProviderConfigurationError(
      "The routing deployment attestation must bind OTP and GraphHopper graph artifacts.",
    );
  }
  const otpGraph = readAttestedArtifact(value.artifacts.otpGraph, "otpGraph");
  const graphhopper = readAttestedArtifact(value.artifacts.graphhopper, "graphhopper");
  if (otpGraph.contentHash !== snapshot.artifacts.graph.contentHash) {
    throw new ProviderConfigurationError("The attested OTP graph disagrees with the manifest.");
  }
  return {
    otp: {
      manifest: snapshot,
      engine: "otp",
      graphArtifact: otpGraph,
      inputArtifact: snapshot.artifacts.input,
    },
    graphhopper: {
      manifest: snapshot,
      engine: "graphhopper",
      graphArtifact: graphhopper,
      inputArtifact: snapshot.artifacts.input,
    },
  };
}

function readAttestedArtifact(
  value: Record<string, unknown>,
  label: string,
): RoutingArtifactIdentity {
  if (typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(String(value.contentHash))) {
    throw new ProviderConfigurationError(`The attested ${label} artifact identity is invalid.`);
  }
  return { id: value.id, contentHash: value.contentHash as string };
}

function loadAttestedAccessEnvelope(
  manifestBytes: string,
  snapshot: RoutingSnapshot,
  value: unknown,
  manifestPath: string,
): GeoJsonGeometry {
  if (!isRecord(value) ||
    value.contractVersion !== snapshot.contractVersion ||
    value.manifestId !== snapshot.manifestId ||
    value.generatedAt !== snapshot.generatedAt ||
    value.manifestSha256 !== sha256(manifestBytes)) {
    throw new ProviderConfigurationError("The routing deployment attestation does not match the manifest.");
  }
  const transformations = value.transformations;
  if (!Array.isArray(transformations)) {
    throw new ProviderConfigurationError("The routing deployment attestation has no transformation state.");
  }
  const appliedById = new Map<string, unknown>();
  for (const transformation of transformations) {
    if (isRecord(transformation) && typeof transformation.id === "string") {
      appliedById.set(transformation.id, transformation.applied);
    }
  }
  const requiredTransformations: Record<string, boolean> = {
    "mvv-authoritative-schedule": true,
    "mvg-metadata-enrichment": false,
    "realtime-overlay": false,
    "official-munich-access-envelope-15km": true,
    "otp-graph-import": true,
    "graphhopper-profile-import": true,
  };
  if (Object.entries(requiredTransformations).some(([id, applied]) => appliedById.get(id) !== applied)) {
    throw new ProviderConfigurationError(
      "The routing deployment attestation has unsafe MVV, MVG, or realtime application state.",
    );
  }
  const envelope = value.accessEnvelope;
  if (!isRecord(envelope) ||
    envelope.crs !== "EPSG:25832" ||
    envelope.radiusMeters !== 15_000 ||
    !isRecord(envelope.artifact) ||
    envelope.artifact.id !== snapshot.accessEnvelope.artifact.id ||
    envelope.artifact.contentHash !== snapshot.accessEnvelope.artifact.contentHash ||
    typeof envelope.path !== "string") {
    throw new ProviderConfigurationError("The routing access-envelope attestation is not canonical.");
  }
  const envelopePath = resolveAttestedPath(envelope.path, manifestPath);
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(readFileSync(/* turbopackIgnore: true */ envelopePath, "utf8")) as unknown;
  } catch {
    throw new ProviderConfigurationError("The attested access-envelope artifact is not readable.");
  }
  if (sha256File(envelopePath) !== snapshot.accessEnvelope.artifact.contentHash) {
    throw new ProviderConfigurationError("The access-envelope artifact hash does not match the manifest.");
  }
  return parseAccessEnvelopeGeometry(envelopeValue);
}

function parseAccessEnvelopeGeometry(value: unknown): GeoJsonGeometry {
  if (!isRecord(value) || value.type !== "FeatureCollection" ||
    !Array.isArray(value.features) || value.features.length !== 1 ||
    !isRecord(value.features[0])) {
    throw new ProviderConfigurationError("The access-envelope artifact must be one GeoJSON feature.");
  }
  const feature = value.features[0];
  if (!isRecord(value.crs) || !isRecord(value.crs.properties) ||
    value.crs.properties.name !== "EPSG:25832" ||
    !isRecord(feature.properties) ||
    feature.properties.kind !== "official-munich-access-envelope" ||
    feature.properties.radiusMeters !== 15_000) {
    throw new ProviderConfigurationError("The access-envelope artifact metadata is not canonical.");
  }
  const geometry = feature.geometry;
  if (!isRecord(geometry)) {
    throw new ProviderConfigurationError("The access-envelope artifact is missing geometry.");
  }
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    throw new ProviderConfigurationError("The access-envelope artifact must be a Polygon or MultiPolygon.");
  }
  try {
    return transformProjectedGeometry(geometry);
  } catch {
    throw new ProviderConfigurationError("The access-envelope artifact contains invalid EPSG:25832 geometry.");
  }
}

function transformProjectedGeometry(
  value: Record<string, unknown>,
): GeoJsonGeometry {
  if (value.type === "Polygon" && Array.isArray(value.coordinates) && value.coordinates.length > 0) {
    return { type: "Polygon", coordinates: transformRings(value.coordinates) };
  }
  if (value.type === "MultiPolygon" && Array.isArray(value.coordinates) && value.coordinates.length > 0) {
    return {
      type: "MultiPolygon",
      coordinates: value.coordinates.map((polygon) => {
        if (!Array.isArray(polygon)) throw new Error("invalid polygon");
        return transformRings(polygon);
      }),
    };
  }
  throw new Error("invalid geometry");
}

function transformRings(value: unknown[]): GeoJsonPosition[][] {
  if (value.length === 0) throw new Error("empty rings");
  return value.map((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("invalid ring");
    const positions = ring.map((position) => {
      if (!Array.isArray(position) || position.length !== 2 ||
        typeof position[0] !== "number" || typeof position[1] !== "number" ||
        !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
        throw new Error("invalid position");
      }
      return utm32ToWgs84(position[0], position[1]);
    });
    const first = positions[0];
    const last = positions[positions.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error("ring is not closed");
    }
    return positions;
  });
}

/** Inverse of EPSG:25832 (UTM zone 32N), used for the generated envelope only. */
function utm32ToWgs84(easting: number, northing: number): GeoJsonPosition {
  const a = 6_378_137;
  const eccentricitySquared = 0.00669438;
  const eccentricityPrimeSquared = eccentricitySquared / (1 - eccentricitySquared);
  const scale = 0.9996;
  const x = easting - 500_000;
  const y = northing;
  const meridionalArc = y / scale;
  const mu = meridionalArc / (a * (1 - eccentricitySquared / 4 - 3 * eccentricitySquared ** 2 / 64 - 5 * eccentricitySquared ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - eccentricitySquared)) / (1 + Math.sqrt(1 - eccentricitySquared));
  const footprintLatitude = mu +
    (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
    (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
    (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
    (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sine = Math.sin(footprintLatitude);
  const cosine = Math.cos(footprintLatitude);
  const tangent = Math.tan(footprintLatitude);
  const radius = a / Math.sqrt(1 - eccentricitySquared * sine ** 2);
  const curvature = a * (1 - eccentricitySquared) /
    (1 - eccentricitySquared * sine ** 2) ** 1.5;
  const distance = x / (radius * scale);
  const latitude = footprintLatitude - (radius * tangent / curvature) *
    (distance ** 2 / 2 - (5 + 3 * tangent ** 2 + 10 * eccentricityPrimeSquared * cosine ** 2 - 4 * eccentricityPrimeSquared ** 2 * cosine ** 4 - 9 * eccentricityPrimeSquared) * distance ** 4 / 24 +
      (61 + 90 * tangent ** 2 + 298 * eccentricityPrimeSquared * cosine ** 2 + 45 * tangent ** 4 - 252 * eccentricityPrimeSquared ** 2 * cosine ** 4 - 3 * eccentricityPrimeSquared ** 2) * distance ** 6 / 720);
  const longitude = (9 * Math.PI / 180) +
    (distance - (1 + 2 * tangent ** 2 + eccentricityPrimeSquared * cosine ** 2) * distance ** 3 / 6 +
      (5 - 2 * eccentricityPrimeSquared * cosine ** 2 + 28 * tangent ** 2 - 3 * eccentricityPrimeSquared ** 2 * cosine ** 4 + 8 * eccentricityPrimeSquared + 24 * tangent ** 4) * distance ** 5 / 120) / cosine;
  const result: GeoJsonPosition = [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
  if (!Number.isFinite(result[0]) || !Number.isFinite(result[1]) ||
    result[0] < -180 || result[0] > 180 || result[1] < -90 || result[1] > 90) {
    throw new Error("projected coordinate is outside WGS84");
  }
  return result;
}

function resolveAttestedPath(path: string, manifestPath: string): string {
  if (basename(path) !== ACCESS_ENVELOPE_FILENAME) {
    throw new ProviderConfigurationError("The attested access-envelope filename is not canonical.");
  }
  const candidate = resolve(/* turbopackIgnore: true */ path);
  if (readableFile(candidate)) return candidate;
  const alongsideManifest = resolve(
    /* turbopackIgnore: true */ dirname(manifestPath),
    path,
  );
  if (readableFile(alongsideManifest)) return alongsideManifest;
  throw new ProviderConfigurationError("The attested access-envelope path is not readable.");
}

function readableFile(path: string): boolean {
  try {
    return readFileSync(/* turbopackIgnore: true */ path).length > 0;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(/* turbopackIgnore: true */ path)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredManifestPath(value: string | undefined): string {
  const path = readRequiredString(value, "MEEET_ROUTING_MANIFEST_PATH");
  if (basename(path) !== ROUTING_MANIFEST_FILENAME) {
    throw new ProviderConfigurationError(
      `MEEET_ROUTING_MANIFEST_PATH must name ${ROUTING_MANIFEST_FILENAME}.`,
    );
  }
  return resolve(/* turbopackIgnore: true */ path);
}

function readRequiredEndpointUrl(
  value: string | undefined,
  name: string,
  requiredPathSuffix: string,
  allowHttp: boolean,
): string {
  const result = readOptionalUrl(value, name, allowHttp);
  if (!result) throw new ProviderConfigurationError(`${name} is required.`);
  const parsed = new URL(result);
  if (parsed.search || !parsed.pathname.endsWith(requiredPathSuffix)) {
    throw new ProviderConfigurationError(`${name} must be a fixed endpoint ending in ${requiredPathSuffix}.`);
  }
  return result;
}

function readRequiredProfile(value: string | undefined, name: string): string {
  const profile = readRequiredString(value, name);
  if (!/^[A-Za-z0-9_,:-]+$/.test(profile)) {
    throw new ProviderConfigurationError(`${name} contains unsupported profile characters.`);
  }
  return profile;
}

function rejectSelfHostedOperatorProvenance(env: ProviderEnvironment): void {
  const configuredKeys = Object.keys(env).filter(
    (key) =>
      (key.startsWith("MEEET_ROUTING_MVG_") || key.startsWith("MEEET_ROUTING_MVV_")) &&
      Boolean(env[key]?.trim()),
  );
  if (configuredKeys.length > 0) {
    throw new ProviderConfigurationError(
      `self-hosted-routing provenance must come from MEEET_ROUTING_MANIFEST_PATH, not environment claims: ${configuredKeys.join(", ")}.`,
    );
  }
}

function readOptionalUrl(
  value: string | undefined,
  name: string,
  allowHttp = false,
): string | null {
  if (!value?.trim()) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderConfigurationError(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new ProviderConfigurationError(
      `${name} must be an HTTP(S) URL without embedded credentials or fragments.`,
    );
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    throw new ProviderConfigurationError(
      `${name} must use HTTPS unless trusted development HTTP is explicitly enabled.`,
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new ProviderConfigurationError(
      `${name} may use HTTP only for a loopback host in development.`,
    );
  }
  return parsed.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function readOptionalString(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function readFeedProvenance(
  env: ProviderEnvironment,
  prefix: "MEEET_ROUTING_MVG" | "MEEET_ROUTING_MVV",
  name: "MVG" | "MVV",
): FeedProvenance {
  const sourceUrl = readRequiredHttpsUrl(env[`${prefix}_SOURCE_URL`], `${prefix}_SOURCE_URL`);
  const licenseName = readRequiredString(env[`${prefix}_LICENSE`], `${prefix}_LICENSE`);
  const licenseUrl = readRequiredHttpsUrl(
    env[`${prefix}_LICENSE_URL`],
    `${prefix}_LICENSE_URL`,
  );
  const attribution = readRequiredString(
    env[`${prefix}_ATTRIBUTION`],
    `${prefix}_ATTRIBUTION`,
  );
  const version = readRequiredString(env[`${prefix}_VERSION`], `${prefix}_VERSION`);
  const retrievedAt = readRequiredIsoInstant(
    env[`${prefix}_RETRIEVED_AT`],
    `${prefix}_RETRIEVED_AT`,
  );
  return {
    name,
    sourceUrl,
    license: { name: licenseName, url: licenseUrl },
    attribution,
    version,
    retrievedAt,
  };
}

function readConfiguredSourceMetadata(
  env: ProviderEnvironment,
  prefix: "MEEET_GEOCODING" | "MEEET_POI",
): ConfiguredSourceMetadata {
  const sourceUrl = readRequiredHttpsUrl(
    env[`${prefix}_SOURCE_URL`],
    `${prefix}_SOURCE_URL`,
  );
  const licenseName = readRequiredString(env[`${prefix}_LICENSE`], `${prefix}_LICENSE`);
  const licenseUrl = readRequiredHttpsUrl(
    env[`${prefix}_LICENSE_URL`],
    `${prefix}_LICENSE_URL`,
  );
  return {
    name: readRequiredString(env[`${prefix}_SOURCE_NAME`], `${prefix}_SOURCE_NAME`),
    url: sourceUrl,
    license: { name: licenseName, url: licenseUrl },
    attribution: readRequiredString(
      env[`${prefix}_ATTRIBUTION`],
      `${prefix}_ATTRIBUTION`,
    ),
    version: readRequiredString(env[`${prefix}_VERSION`], `${prefix}_VERSION`),
    retrievedAt: readRequiredIsoInstant(
      env[`${prefix}_RETRIEVED_AT`],
      `${prefix}_RETRIEVED_AT`,
    ),
  };
}

function readRequiredHttpsUrl(value: string | undefined, name: string): string {
  const url = readOptionalUrl(value, name);
  if (!url || !url.startsWith("https://")) {
    throw new ProviderConfigurationError(`${name} must be a required HTTPS URL.`);
  }
  return url;
}

function readRequiredString(value: string | undefined, name: string): string {
  const result = readOptionalString(value);
  if (!result || result.length > 512) {
    throw new ProviderConfigurationError(`${name} must be a non-empty string of at most 512 characters.`);
  }
  return result;
}

function readRequiredIsoInstant(value: string | undefined, name: string): string {
  const result = readRequiredString(value, name);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || !result.includes("T")) {
    throw new ProviderConfigurationError(`${name} must be an ISO timestamp.`);
  }
  return parsed.toISOString();
}

function readOptionalSecret(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function readDeployment(value: string | undefined): ProviderDeploymentKind {
  const deployment = value?.trim() || "unknown";
  if (
    deployment !== "fixture" &&
    deployment !== "self-hosted" &&
    deployment !== "managed" &&
    deployment !== "unknown"
  ) {
    throw new ProviderConfigurationError(
      "MEEET_PROVIDER_DEPLOYMENT must be fixture, self-hosted, managed, or unknown.",
    );
  }
  return deployment;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProviderConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}
