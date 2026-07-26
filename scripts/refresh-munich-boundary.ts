import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as polygonClippingModule from "polygon-clipping";

type PolygonClippingApi = {
  union: (geometry: number[][][][]) => number[][][][];
};

const polygonClipping = (
  polygonClippingModule as unknown as {
    default?: PolygonClippingApi;
  } & PolygonClippingApi
).default ?? (polygonClippingModule as unknown as PolygonClippingApi);

const SOURCE_URL =
  "https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=gsm_wfs%3Avablock_stadtbezirk&outputFormat=application%2Fjson&srsName=EPSG%3A4326";
const METADATA_URL =
  "https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS&version=1.0.0&request=GetCapabilities";
const LICENSE_URL = "https://www.govdata.de/dl-de/by-2-0";
const OUTPUT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/official",
);
const RAW_PATH = path.join(OUTPUT_DIRECTORY, "munich-stadtbezirke.raw.geojson");
const NORMALIZED_PATH = path.join(
  OUTPUT_DIRECTORY,
  "munich-districts.json",
);
const MANIFEST_PATH = path.join(
  OUTPUT_DIRECTORY,
  "munich-boundary-manifest.json",
);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MUNICH_ENVELOPE = {
  minLatitude: 47.9,
  maxLatitude: 48.4,
  minLongitude: 11.2,
  maxLongitude: 11.9,
};

interface RawFeature {
  type: "Feature";
  id?: string;
  properties?: Record<string, unknown>;
  geometry?: RawGeometry;
}

interface RawFeatureCollection {
  type: "FeatureCollection";
  features: RawFeature[];
}

interface RawGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

interface NormalizedDistrict {
  type: "Feature";
  id: string;
  properties: {
    districtNumber: string;
    districtName: string;
  };
  geometry: {
    type: "MultiPolygon";
    coordinates: number[][][][];
  };
}

interface NormalizedCollection {
  type: "FeatureCollection";
  features: NormalizedDistrict[];
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const retrievedAt = new Date().toISOString();
  const rawResponse = await fetchBytes(SOURCE_URL);
  const metadataResponse = await fetchBytes(METADATA_URL, true);
  const rawText = new TextDecoder().decode(rawResponse.bytes);
  const rawCollection = parseRawCollection(rawText);
  const normalized = normalizeDistricts(rawCollection);
  validateMunichEnvelope(normalized);
  const normalizedText = `${JSON.stringify(normalized, null, 2)}\n`;
  const sourceMetadataDate =
    rawResponse.lastModified ?? metadataResponse.lastModified ?? null;
  const manifest = {
    schemaVersion: 1,
    boundaryType: "application-municipal-district-collection",
    legalBoundary: false,
    sourceUrl: SOURCE_URL,
    metadataUrl: METADATA_URL,
    retrievedAt,
    sourceMetadataDate,
    metadataRetrievedAt: metadataResponse.retrievedAt,
    rawContentHash: sha256(rawResponse.bytes),
    normalizedContentHash: sha256(Buffer.from(normalizedText)),
    metadataContentHash: sha256(metadataResponse.bytes),
    rawFeatureCount: rawCollection.features.length,
    districtCount: normalized.features.length,
    license: {
      name: "DL-DE-BY-2.0",
      url: LICENSE_URL,
    },
    attribution:
      "Landeshauptstadt München / GeodatenService München — Stadtbezirke",
    note:
      "The 25-district collection is used for application membership and clipping only. It is not a legal or cadastral boundary.",
  } as const;

  await writeFile(RAW_PATH, rawResponse.bytes);
  await writeFile(NORMALIZED_PATH, normalizedText, "utf8");
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const rawRoundTrip = await readFile(RAW_PATH);
  if (sha256(rawRoundTrip) !== manifest.rawContentHash) {
    throw new Error("Raw boundary hash did not survive the write/read round trip.");
  }
  const normalizedRoundTrip = await readFile(NORMALIZED_PATH);
  if (sha256(normalizedRoundTrip) !== manifest.normalizedContentHash) {
    throw new Error("Normalized boundary hash did not survive the write/read round trip.");
  }
  validateManifest(manifest);
  console.log(
    `Wrote ${normalized.features.length} districts from ${rawCollection.features.length} WFS features.`,
  );
  console.log(`Raw SHA-256: ${manifest.rawContentHash}`);
  console.log(`Normalized SHA-256: ${manifest.normalizedContentHash}`);
}

async function fetchBytes(
  url: string,
  allowEmptyServiceResponse = false,
): Promise<{
  bytes: Uint8Array;
  lastModified: string | null;
  retrievedAt: string;
}> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { accept: "application/json, application/xml, text/xml" },
  });
  if (!response.ok) {
    throw new Error(`Boundary source returned HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Boundary source response exceeds the refresh size limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Boundary source response exceeds the refresh size limit.");
  }
  if (!allowEmptyServiceResponse && bytes.byteLength === 0) {
    throw new Error("Boundary source returned an empty response.");
  }
  return {
    bytes,
    lastModified: response.headers.get("last-modified"),
    retrievedAt: new Date().toISOString(),
  };
}

function parseRawCollection(rawText: string): RawFeatureCollection {
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed) || parsed.type !== "FeatureCollection") {
    throw new Error("Boundary source is not a GeoJSON FeatureCollection.");
  }
  if (!Array.isArray(parsed.features)) {
    throw new Error("Boundary source has no feature array.");
  }
  return parsed as unknown as RawFeatureCollection;
}

function normalizeDistricts(raw: RawFeatureCollection): NormalizedCollection {
  const districts = new Map<string, { name: string; polygons: number[][][][] }>();
  for (const feature of raw.features) {
    if (feature.type !== "Feature") {
      throw new Error("Every district entry must be a GeoJSON Feature.");
    }
    const districtNumber = readDistrictNumber(feature);
    const districtName = readDistrictName(feature);
    const polygons = geometryToPolygons(feature.geometry);
    const existing = districts.get(districtNumber) ?? {
      name: districtName,
      polygons: [],
    };
    if (existing.name !== districtName) {
      throw new Error(`District ${districtNumber} has inconsistent names.`);
    }
    existing.polygons.push(...polygons);
    districts.set(districtNumber, existing);
  }
  if (districts.size !== 25) {
    throw new Error(
      `Expected exactly 25 unique district features after grouping split parts; received ${districts.size}.`,
    );
  }
  const expectedDistricts = new Set(
    Array.from({ length: 25 }, (_, index) => String(index + 1).padStart(2, "0")),
  );
  if ([...districts.keys()].some((districtNumber) => !expectedDistricts.has(districtNumber))) {
    throw new Error("Boundary source contains an unexpected district id.");
  }

  const features = [...districts.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([districtNumber, district]) => {
      try {
        const union = polygonClipping.union(district.polygons);
        if (union.length === 0) {
          throw new Error("empty union");
        }
      } catch {
        throw new Error(`District ${districtNumber} failed polygon topology validation.`);
      }
      return {
        type: "Feature" as const,
        id: `munich-district-${districtNumber}`,
        properties: {
          districtNumber,
          districtName: district.name,
        },
        geometry: {
          type: "MultiPolygon" as const,
          coordinates: district.polygons,
        },
      };
    });
  return { type: "FeatureCollection", features };
}

function validateMunichEnvelope(collection: NormalizedCollection): void {
  const positions = collection.features.flatMap((feature) =>
    feature.geometry.coordinates.flatMap((polygon) => polygon.flatMap((ring) => ring)),
  );
  if (
    positions.some(
      ([longitude, latitude]) =>
        latitude < MUNICH_ENVELOPE.minLatitude ||
        latitude > MUNICH_ENVELOPE.maxLatitude ||
        longitude < MUNICH_ENVELOPE.minLongitude ||
        longitude > MUNICH_ENVELOPE.maxLongitude,
    )
  ) {
    throw new Error("Boundary source coordinates fall outside the Munich-specific envelope.");
  }
}

function validateManifest(manifest: {
  sourceUrl: string;
  metadataUrl: string;
  retrievedAt: string;
  metadataRetrievedAt: string;
  rawContentHash: string;
  normalizedContentHash: string;
  metadataContentHash: string;
  districtCount: number;
  license: { name: string; url: string };
  attribution: string;
  legalBoundary: false;
}): void {
  if (
    !manifest.sourceUrl.startsWith("https://") ||
    !manifest.metadataUrl.startsWith("https://") ||
    !manifest.retrievedAt.includes("T") ||
    !manifest.metadataRetrievedAt.includes("T") ||
    !/^[a-f0-9]{64}$/.test(manifest.rawContentHash) ||
    !/^[a-f0-9]{64}$/.test(manifest.normalizedContentHash) ||
    !/^[a-f0-9]{64}$/.test(manifest.metadataContentHash) ||
    manifest.districtCount !== 25 ||
    !manifest.license.name ||
    !manifest.license.url.startsWith("https://") ||
    !manifest.attribution ||
    manifest.legalBoundary !== false
  ) {
    throw new Error("Boundary manifest is missing required provenance metadata.");
  }
}

function readDistrictNumber(feature: RawFeature): string {
  const value = feature.properties?.sb_nummer;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Every district feature must have sb_nummer.");
  }
  const districtNumber = String(value).padStart(2, "0");
  if (!/^\d{2}$/.test(districtNumber)) {
    throw new Error(`Invalid district number ${districtNumber}.`);
  }
  return districtNumber;
}

function readDistrictName(feature: RawFeature): string {
  const value = feature.properties?.sb_name;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Every district feature must have sb_name.");
  }
  return value.trim();
}

function geometryToPolygons(geometry: RawGeometry | undefined): number[][][][] {
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
    throw new Error("Every district feature must have a Polygon or MultiPolygon geometry.");
  }
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]);
  if (!Array.isArray(geometry.coordinates)) {
    throw new Error("District geometry must contain coordinates.");
  }
  polygons.forEach(validatePolygon);
  return polygons;
}

function validatePolygon(polygon: number[][][]): void {
  if (polygon.length === 0) {
    throw new Error("District polygon has no rings.");
  }
  polygon.forEach((ring) => {
    if (ring.length < 4 || !samePosition(ring[0], ring[ring.length - 1])) {
      throw new Error("District rings must be closed and contain at least four positions.");
    }
    const area = Math.abs(
      ring.reduce((sum, position, index) => {
        const next = ring[(index + 1) % ring.length];
        return sum + position[0] * next[1] - next[0] * position[1];
      }, 0) / 2,
    );
    if (area <= 1e-12) {
      throw new Error("District ring has zero area.");
    }
    ring.forEach(([longitude, latitude]) => {
      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90
      ) {
        throw new Error("District coordinates must be finite WGS84 positions.");
      }
    });
  });
}

function samePosition(first: number[] | undefined, second: number[] | undefined): boolean {
  return Boolean(
    first &&
      second &&
      first.length === 2 &&
      second.length === 2 &&
      first[0] === second[0] &&
      first[1] === second[1],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Boundary refresh failed.");
  process.exitCode = 1;
});
