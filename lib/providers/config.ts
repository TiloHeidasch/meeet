import "server-only";

import type {
  FeedProvenance,
  ProviderDeploymentKind,
  SourceLicense,
} from "../domain/types.ts";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 4_000;
export const MIN_PROVIDER_TIMEOUT_MS = 250;
export const MAX_PROVIDER_TIMEOUT_MS = 10_000;
export const DEFAULT_PROVIDER_MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ProviderMode = "fixture" | "configured" | "mvg-direct-transit";

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderConfig {
  mode: ProviderMode;
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
    requestedMode !== "mvg-direct-transit"
  ) {
    throw new ProviderConfigurationError(
      "MEEET_PROVIDER_MODE must be fixture, configured, or mvg-direct-transit.",
    );
  }

  if (requestedMode === "mvg-direct-transit") {
    rejectDirectProviderConfiguration(env);
    const deployment = env.MEEET_PROVIDER_DEPLOYMENT?.trim();
    if (deployment && deployment !== "unknown") {
      throw new ProviderConfigurationError(
        "MEEET_PROVIDER_DEPLOYMENT must be omitted or unknown in mvg-direct-transit mode.",
      );
    }
  }

  // Direct MVG routing has a fixed server-side origin. Provider endpoint,
  // token, and source metadata variables are rejected in this mode rather
  // than allowing an alternate integration to be silently ignored.
  const endpoints =
    requestedMode === "mvg-direct-transit"
      ? { routingGatewayUrl: null, geocodingUrl: null, poiUrl: null }
      : {
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
  const mode: ProviderMode =
    requestedMode === "mvg-direct-transit"
      ? "mvg-direct-transit"
      : requestedMode === "fixture" || (!requestedMode && !hasConfiguredEndpoint)
      ? "fixture"
      : "configured";
  const deployment = readDeployment(env.MEEET_PROVIDER_DEPLOYMENT);
  if (requestedMode === "fixture" && hasConfiguredEndpoint) {
    throw new ProviderConfigurationError(
      "MEEET_PROVIDER_MODE=fixture cannot be combined with configured provider endpoints.",
    );
  }
  if (mode === "configured" && deployment === "fixture") {
    throw new ProviderConfigurationError(
      "Configured provider mode cannot use fixture deployment metadata.",
    );
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

  return {
    mode,
    ...endpoints,
    routingGatewayToken:
      mode === "mvg-direct-transit" ? null : readOptionalSecret(env.MEEET_ROUTING_GATEWAY_TOKEN),
    geocodingToken:
      mode === "mvg-direct-transit" ? null : readOptionalSecret(env.MEEET_GEOCODING_TOKEN),
    poiToken: mode === "mvg-direct-transit" ? null : readOptionalSecret(env.MEEET_POI_TOKEN),
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
  };
}

function rejectDirectProviderConfiguration(env: ProviderEnvironment): void {
  const configuredKeys = Object.keys(env).filter(
    (key) =>
      (key.startsWith("MEEET_ROUTING_") ||
        key.startsWith("MEEET_GEOCODING_") ||
        key.startsWith("MEEET_POI_")) &&
      Boolean(env[key]?.trim()),
  );
  if (configuredKeys.length > 0) {
    throw new ProviderConfigurationError(
      `mvg-direct-transit cannot be combined with configured provider settings: ${configuredKeys.join(", ")}.`,
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
  return parsed.toString();
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
