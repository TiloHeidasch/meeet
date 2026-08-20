import "server-only";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deserialize, serialize } from "node:v8";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ProviderConfigurationError } from "../../providers/config.ts";
import { logCompilerProgress, logInfo, elapsedMs } from "../../log.ts";

import {
  calculateScheduledCompiledArtifactId,
  calculateScheduledContentHash,
  compareScheduledConnections,
  compareScheduledIds,
  importGtfsSchedule,
  type GtfsFeedFiles,
  type ScheduledArtifactCore,
} from "./gtfs.ts";
import { parseOffsetInstant } from "./time.ts";
import type {
  GtfsAcquisitionRecord,
  ScheduledRoutingArtifact,
} from "./models.ts";
import { SCHEDULED_ROUTING_CONTRACT_VERSION } from "./models.ts";

export const SCHEDULED_MVV_FEED_URL =
  "https://www.mvv-muenchen.de/fileadmin/mediapool/developer/opendata/gesamt_gtfs.zip";

const MAX_GTFS_ARCHIVE_LIST_BYTES = 8 * 1024 * 1024;
const MAX_GTFS_TEXT_FILE_BYTES = 512 * 1024 * 1024;
const OFFICIAL_MVV_ATTRIBUTION = "Münchner Verkehrs- und Tarifverbund GmbH (MVV)";
const DEFAULT_CC_BY_4_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const MVV_ATTRIBUTION_POLICY_ID = "mvv-cc-by-4.0-fallback/v1" as const;
const SCHEDULED_BUNDLE_CONTRACT_VERSION = "meeet-scheduled-routing-bundle/v1" as const;
export const SCHEDULED_COMPILER_VERSION = "meeet-scheduled-compiler/v2" as const;
const SCHEDULED_BUNDLE_ENCODING = "node-v8-structured-clone/1" as const;
const MAX_BUNDLE_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_BUNDLE_PAYLOAD_BYTES = 1 * 1024 * 1024 * 1024;
const loadedScheduledArtifacts = new Map<string, ScheduledRoutingArtifact>();

interface ScheduledBundleCounts {
  readonly routes: number;
  readonly trips: number;
  readonly stationAreas: number;
  readonly calendars: number;
  readonly exceptions: number;
  readonly connections: number;
}

interface ScheduledBundleSummary {
  readonly feedId: string;
  readonly timeZone: string;
  readonly serviceDateRange: ScheduledArtifactCore["serviceDateRange"];
  readonly maximumServiceDayTimeSeconds: number;
  readonly searchStartBounds: ScheduledArtifactCore["searchStartBounds"];
  readonly counts: ScheduledBundleCounts;
}

export interface ScheduledBundleManifest {
  readonly contractVersion: typeof SCHEDULED_BUNDLE_CONTRACT_VERSION;
  readonly encoding: typeof SCHEDULED_BUNDLE_ENCODING;
  readonly writerNodeMajor: number;
  readonly payloadFile: string;
  readonly payloadByteLength: number;
  readonly payloadSha256: string;
  readonly compiledArtifactId: string;
  readonly summary: ScheduledBundleSummary;
  readonly provenance: ScheduledRoutingArtifact["provenance"];
  /** Compiler identity that produced the bundle; absent in legacy artifacts. */
  readonly compilerVersion?: string;
}

export interface CompileScheduledArtifactInput {
  readonly sourceUrl?: string;
  readonly inputPath?: string;
  readonly rawArchiveBytes?: Uint8Array;
  readonly feedFiles?: GtfsFeedFiles;
  readonly retrievedAt?: string;
  readonly feedId?: string;
}

export interface LoadScheduledArtifactOptions {
  readonly now?: string;
  readonly rawArchiveBytes?: Uint8Array;
}

export class ScheduleArtifactUnavailableError extends ProviderConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleArtifactUnavailableError";
  }
}

export function compileScheduledArtifact(input: CompileScheduledArtifactInput): ScheduledRoutingArtifact {
  const sourceUrl = input.sourceUrl ?? SCHEDULED_MVV_FEED_URL;
  if (sourceUrl !== SCHEDULED_MVV_FEED_URL) {
    throw new ScheduleArtifactUnavailableError("The MVV compiler accepts only the canonical Gesamt-GTFS URL.");
  }
  let rawArchiveBytes = input.rawArchiveBytes;
  let feedFiles = input.feedFiles;
  if (input.inputPath !== undefined) {
    if (!isAbsolute(input.inputPath)) throw new ScheduleArtifactUnavailableError("Offline GTFS compiler inputPath must be absolute.");
    rawArchiveBytes = new Uint8Array(readFileSync(input.inputPath));
    logCompilerProgress(`loading local GTFS archive: ${input.inputPath} (${rawArchiveBytes.byteLength} bytes)`);
    feedFiles = extractGtfsTextFiles(input.inputPath);
  }
  if (rawArchiveBytes === undefined || feedFiles === undefined) {
    throw new ScheduleArtifactUnavailableError("The offline compiler requires raw archive bytes and extracted GTFS text files.");
  }
  const feedInfo = parseFeedInfo(feedFiles["feed_info.txt"]);
  const official = parseOfficialAttribution(feedFiles["attributions.txt"], feedInfo);
  const acquisition: GtfsAcquisitionRecord = {
    sourceUrl,
    retrievedAt: input.retrievedAt ?? defaultAcquisitionRetrievedAt(),
    rawArchiveByteSize: rawArchiveBytes.byteLength,
    rawArchiveSha256: sha256Bytes(rawArchiveBytes),
    feedVersion: feedInfo.feedVersion,
    feedValidFrom: feedInfo.feedValidFrom,
    feedValidUntil: feedInfo.feedValidUntil,
    attribution: `${feedInfo.publisherName} (${feedInfo.publisherUrl})`,
    officialAttribution: official.attribution,
    officialLicense: official.license,
    officialProvenance: official.provenance,
  };
  return importGtfsSchedule(feedFiles, {
    feedId: input.feedId ?? feedInfo.feedVersion,
    acquisition,
  });
}

function defaultAcquisitionRetrievedAt(): string {
  return new Date(Math.trunc(Date.now() / 1_000) * 1_000).toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type FetchCompileScheduledArtifactInput = Omit<CompileScheduledArtifactInput, "inputPath" | "rawArchiveBytes" | "feedFiles">;

async function downloadScheduledMvvFeed(fetchImplementation: typeof fetch = fetch): Promise<Uint8Array> {
  logCompilerProgress(`downloading MVV GTFS feed from ${SCHEDULED_MVV_FEED_URL}`);
  const startedAt = performance.now();
  const response = await fetchImplementation(SCHEDULED_MVV_FEED_URL, { redirect: "error" });
  if (!response.ok) throw new ScheduleArtifactUnavailableError(`The MVV GTFS download returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  logCompilerProgress(`feed download complete: ${bytes.byteLength} bytes in ${elapsedMs(startedAt)}ms`);
  return bytes;
}

function compileScheduledArtifactFromBytes(
  input: Omit<FetchCompileScheduledArtifactInput, "sourceUrl">,
  sourceUrl: string,
  bytes: Uint8Array,
): ScheduledRoutingArtifact {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "meeet-mvv-"));
  const archivePath = join(temporaryDirectory, "gesamt_gtfs.zip");
  writeFileSync(archivePath, bytes);
  try {
    return compileScheduledArtifact({ ...input, sourceUrl, inputPath: archivePath });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function fetchAndCompileScheduledArtifact(
  input: FetchCompileScheduledArtifactInput = {},
  fetchImplementation: typeof fetch = fetch,
): Promise<ScheduledRoutingArtifact> {
  const sourceUrl = input.sourceUrl ?? SCHEDULED_MVV_FEED_URL;
  if (sourceUrl !== SCHEDULED_MVV_FEED_URL) throw new ScheduleArtifactUnavailableError("The MVV compiler accepts only the canonical Gesamt-GTFS URL.");
  const bytes = await downloadScheduledMvvFeed(fetchImplementation);
  return compileScheduledArtifactFromBytes(input, sourceUrl, bytes);
}

export function writeScheduledArtifact(path: string, artifact: ScheduledRoutingArtifact): void {
  if (!isAbsolute(path)) throw new ScheduleArtifactUnavailableError("Scheduled artifact output path must be absolute.");
  const absolutePath = resolve(path);
  logCompilerProgress(`writing scheduled artifact to ${absolutePath}`);
  validateArtifactStructure(artifact);
  logCompilerProgress("scheduled artifact structure validated");
  const { compiledArtifactId, ...identity } = artifact.provenance;
  const { provenance, ...core } = artifact;
  if (calculateScheduledContentHash(identity.feedId, identity.timeZone, identity.files) !== identity.contentHash || calculateScheduledCompiledArtifactId(core, identity) !== compiledArtifactId) {
    throw new ScheduleArtifactUnavailableError("The scheduled artifact identity does not match its contents.");
  }
  logCompilerProgress(`scheduled artifact identity verified (compiledArtifactId=${compiledArtifactId})`);
  const payload = serialize(core);
  logCompilerProgress(`payload serialized: ${payload.byteLength} bytes`);
  if (payload.byteLength > MAX_BUNDLE_PAYLOAD_BYTES) throw new ScheduleArtifactUnavailableError("The scheduled artifact payload exceeds the bundle size limit.");
  const payloadFile = `${basename(absolutePath, extname(absolutePath))}-${compiledArtifactId}.v8.bin`;
  const manifest: ScheduledBundleManifest = {
    contractVersion: SCHEDULED_BUNDLE_CONTRACT_VERSION,
    encoding: SCHEDULED_BUNDLE_ENCODING,
    writerNodeMajor: currentNodeMajor(),
    payloadFile,
    payloadByteLength: payload.byteLength,
    payloadSha256: sha256Bytes(payload),
    compiledArtifactId,
    summary: bundleSummary(core),
    provenance,
    compilerVersion: SCHEDULED_COMPILER_VERSION,
  };
  const directory = dirname(absolutePath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payloadTemporaryPath = join(directory, `.${payloadFile}.${nonce}.tmp`);
  const manifestTemporaryPath = join(directory, `.${basename(absolutePath)}.${nonce}.tmp`);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.byteLength > MAX_BUNDLE_MANIFEST_BYTES) throw new ScheduleArtifactUnavailableError("The scheduled artifact manifest exceeds the bundle size limit.");
  try {
    writeFileSync(payloadTemporaryPath, payload);
    renameSync(payloadTemporaryPath, join(directory, payloadFile));
    writeFileSync(manifestTemporaryPath, manifestBytes);
    renameSync(manifestTemporaryPath, absolutePath);
    logCompilerProgress(`artifact written: payload=${payloadFile}, manifest=${absolutePath}`);
  } finally {
    rmSync(payloadTemporaryPath, { force: true });
    rmSync(manifestTemporaryPath, { force: true });
  }
}

export function tryReadScheduledBundleManifest(path: string): ScheduledBundleManifest | null {
  try {
    return readBundleManifest(path);
  } catch {
    return null;
  }
}

export type ScheduledRotationReason =
  | "missing"
  | "missing-payload"
  | "compiler-version"
  | "feed-out-of-date"
  | "feed-changed"
  | "fresh"
  | "check-unavailable";

export interface RotateScheduledArtifactInput {
  readonly outputPath: string;
  readonly sourceUrl?: string;
  readonly now?: string;
  readonly fetchImplementation?: typeof fetch;
}

export interface RotateScheduledArtifactResult {
  readonly action: "compiled" | "kept";
  readonly reason: ScheduledRotationReason;
  readonly outputPath: string;
}

export async function rotateScheduledArtifact(input: RotateScheduledArtifactInput): Promise<RotateScheduledArtifactResult> {
  if (!isAbsolute(input.outputPath)) throw new ScheduleArtifactUnavailableError("Scheduled artifact output path must be absolute.");
  const outputPath = resolve(input.outputPath);
  const sourceUrl = input.sourceUrl ?? SCHEDULED_MVV_FEED_URL;
  if (sourceUrl !== SCHEDULED_MVV_FEED_URL) throw new ScheduleArtifactUnavailableError("The MVV compiler accepts only the canonical Gesamt-GTFS URL.");
  const nowValue = input.now ?? defaultLoaderNow();
  const fetchImplementation = input.fetchImplementation ?? fetch;

  const manifest = tryReadScheduledBundleManifest(outputPath);
  if (manifest === null) {
    logCompilerProgress(`rotation: no existing artifact manifest at ${outputPath}`);
    logCompilerProgress("rotation: proceeding to download and compile (reason=missing)");
    await downloadAndCompileScheduledArtifact(outputPath, sourceUrl, fetchImplementation);
    return { action: "compiled", reason: "missing", outputPath };
  }
  logCompilerProgress(`rotation: existing artifact manifest found (compilerVersion=${manifest.compilerVersion ?? "legacy"}, feedVersion=${manifest.provenance.acquisition.feedVersion})`);
  const payloadPath = join(dirname(outputPath), manifest.payloadFile);
  if (!isExistingPayloadFile(payloadPath)) {
    logCompilerProgress("rotation: proceeding to download and compile (reason=missing-payload)");
    await downloadAndCompileScheduledArtifact(outputPath, sourceUrl, fetchImplementation);
    return { action: "compiled", reason: "missing-payload", outputPath };
  }
  if (manifest.compilerVersion !== SCHEDULED_COMPILER_VERSION) {
    // A version mismatch means the current artifact cannot be trusted (a future
    // artifact structure may be unreadable), so a failed recompile must fail the
    // startup step instead of serving stale-version data.
    logCompilerProgress("rotation: proceeding to download and compile (reason=compiler-version)");
    await downloadAndCompileScheduledArtifact(outputPath, sourceUrl, fetchImplementation);
    return { action: "compiled", reason: "compiler-version", outputPath };
  }
  if (isScheduledFeedValidityOutOfDate(manifest.provenance.acquisition, nowValue)) {
    try {
      await downloadAndCompileScheduledArtifact(outputPath, sourceUrl, fetchImplementation);
    } catch (error) {
      logCompilerProgress(`rotation: feed check failed, keeping existing artifact: ${errorText(error)}`);
      return { action: "kept", reason: "check-unavailable", outputPath };
    }
    logCompilerProgress("rotation: proceeding to download and compile (reason=feed-out-of-date)");
    return { action: "compiled", reason: "feed-out-of-date", outputPath };
  }
  let bytes: Uint8Array;
  try {
    bytes = await downloadScheduledMvvFeed(fetchImplementation);
  } catch (error) {
    logCompilerProgress(`rotation: feed check failed, keeping existing artifact: ${errorText(error)}`);
    return { action: "kept", reason: "check-unavailable", outputPath };
  }
  if (sha256Bytes(bytes) === manifest.provenance.acquisition.rawArchiveSha256) {
    logCompilerProgress("rotation: keeping existing artifact (reason=fresh)");
    return { action: "kept", reason: "fresh", outputPath };
  }
  try {
    compileAndWriteScheduledArtifact(outputPath, sourceUrl, bytes);
  } catch (error) {
    logCompilerProgress(`rotation: feed check failed, keeping existing artifact: ${errorText(error)}`);
    return { action: "kept", reason: "check-unavailable", outputPath };
  }
  logCompilerProgress("rotation: proceeding to download and compile (reason=feed-changed)");
  return { action: "compiled", reason: "feed-changed", outputPath };
}

async function downloadAndCompileScheduledArtifact(
  outputPath: string,
  sourceUrl: string,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const bytes = await downloadScheduledMvvFeed(fetchImplementation);
  compileAndWriteScheduledArtifact(outputPath, sourceUrl, bytes);
}

function compileAndWriteScheduledArtifact(outputPath: string, sourceUrl: string, bytes: Uint8Array): void {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "meeet-mvv-"));
  const archivePath = join(temporaryDirectory, "gesamt_gtfs.zip");
  writeFileSync(archivePath, bytes);
  try {
    const artifact = compileScheduledArtifact({ sourceUrl, inputPath: archivePath });
    writeScheduledArtifact(outputPath, artifact);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function isExistingPayloadFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function loadScheduledArtifact(
  path: string,
  options: LoadScheduledArtifactOptions = {},
): ScheduledRoutingArtifact {
  if (!isAbsolute(path)) throw new ScheduleArtifactUnavailableError("MEEET_SCHEDULE_ARTIFACT_PATH must be absolute.");
  const absolutePath = resolve(path);
  const cached = loadedScheduledArtifacts.get(absolutePath);
  if (cached !== undefined) {
    validateRawArchive(cached, options.rawArchiveBytes);
    validateFreshness(cached.provenance.acquisition, options.now ?? defaultLoaderNow());
    return cached;
  }
  const startedAt = performance.now();
  const heapUsedBefore = process.memoryUsage().heapUsed;
  logInfo(`loading scheduled artifact from ${absolutePath}`);
  const manifest = readBundleManifest(absolutePath);
  const loaderNodeMajor = currentNodeMajor();
  if (manifest.writerNodeMajor !== loaderNodeMajor) throw new ScheduleArtifactUnavailableError(`The configured scheduled artifact was written by Node major ${manifest.writerNodeMajor}, but the loader is running Node major ${loaderNodeMajor}.`);
  const payloadPath = join(dirname(absolutePath), manifest.payloadFile);
  let payloadBytes: Buffer;
  try {
    const payloadLink = lstatSync(payloadPath);
    if (payloadLink.isSymbolicLink()) throw new Error("payload symlink");
    const payloadStats = statSync(payloadPath);
    if (!payloadStats.isFile() || payloadStats.size > MAX_BUNDLE_PAYLOAD_BYTES) throw new Error("payload size");
    payloadBytes = readFileSync(payloadPath);
  } catch {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact payload is missing or exceeds the bundle size limit.");
  }
  if (payloadBytes.byteLength !== manifest.payloadByteLength || sha256Bytes(payloadBytes) !== manifest.payloadSha256) throw new ScheduleArtifactUnavailableError("The configured scheduled artifact payload hash or length does not match its manifest.");
  let decoded: unknown;
  try {
    decoded = deserialize(payloadBytes);
  } catch {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact payload is not valid Node V8 data.");
  }
  if (!isScheduledArtifactCore(decoded)) throw new ScheduleArtifactUnavailableError("The configured scheduled artifact payload failed schema validation.");
  const parsed = { ...decoded, provenance: manifest.provenance } as ScheduledRoutingArtifact;
  if (!isScheduledRoutingArtifact(parsed)) throw new ScheduleArtifactUnavailableError("The configured scheduled artifact failed schema validation.");
  validateArtifactStructure(parsed);
  const { compiledArtifactId, ...identity } = parsed.provenance;
  const { provenance, ...core } = parsed;
  if (calculateScheduledContentHash(identity.feedId, identity.timeZone, identity.files) !== identity.contentHash) {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact file-hash content identity does not match its provenance.");
  }
  if (calculateScheduledCompiledArtifactId(core, identity) !== compiledArtifactId || compiledArtifactId !== manifest.compiledArtifactId) {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact compiled identity does not match its contents.");
  }
  validateBundleSummary(manifest.summary, core);
  validateRawArchive(parsed, options.rawArchiveBytes);
  validateFreshness(provenance.acquisition, options.now ?? defaultLoaderNow());
  const frozen = deepFreeze(parsed);
  loadedScheduledArtifacts.set(absolutePath, frozen);
  const heapUsedAfter = process.memoryUsage().heapUsed;
  logInfo(
    `scheduled artifact loaded in ${elapsedMs(startedAt)}ms (heapDelta=${heapUsedAfter - heapUsedBefore} bytes; compiledArtifactId=${manifest.compiledArtifactId}; contentHash=${identity.contentHash}; feedId=${manifest.summary.feedId}; serviceDateRange=${manifest.summary.serviceDateRange.firstDate}..${manifest.summary.serviceDateRange.lastDate}; compilerVersion=${manifest.compilerVersion ?? "legacy"}; payloadByteLength=${manifest.payloadByteLength}; counts: routes=${manifest.summary.counts.routes}, trips=${manifest.summary.counts.trips}, stationAreas=${manifest.summary.counts.stationAreas}, calendars=${manifest.summary.counts.calendars}, exceptions=${manifest.summary.counts.exceptions}, connections=${manifest.summary.counts.connections})`,
  );
  return frozen;
}

function readBundleManifest(path: string): ScheduledBundleManifest {
  let parsed: unknown;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_BUNDLE_MANIFEST_BYTES) throw new Error("manifest size");
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_BUNDLE_MANIFEST_BYTES) throw new Error("manifest size");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact manifest is missing, oversized, or invalid JSON.");
  }
  if (!isBundleManifest(parsed)) throw new ScheduleArtifactUnavailableError("The configured scheduled artifact manifest failed strict validation.");
  return parsed;
}

function isBundleManifest(value: unknown): value is ScheduledBundleManifest {
  if (!isRecord(value) ||
    (!hasExactKeys(value, ["contractVersion", "encoding", "writerNodeMajor", "payloadFile", "payloadByteLength", "payloadSha256", "compiledArtifactId", "summary", "provenance", "compilerVersion"]) &&
      !hasExactKeys(value, ["contractVersion", "encoding", "writerNodeMajor", "payloadFile", "payloadByteLength", "payloadSha256", "compiledArtifactId", "summary", "provenance"])) ||
    (value.compilerVersion !== undefined && !isCompilerVersion(value.compilerVersion))) return false;
  const summary = value.summary;
  if (!isRecord(summary) || !hasExactKeys(summary, ["feedId", "timeZone", "serviceDateRange", "maximumServiceDayTimeSeconds", "searchStartBounds", "counts"])) return false;
  const counts = summary.counts;
  return value.contractVersion === SCHEDULED_BUNDLE_CONTRACT_VERSION &&
    value.encoding === SCHEDULED_BUNDLE_ENCODING &&
    isSafeInteger(value.writerNodeMajor) && value.writerNodeMajor > 0 &&
    isSafeBundlePayloadFile(value.payloadFile) &&
    isSafeInteger(value.payloadByteLength) && value.payloadByteLength >= 0 && value.payloadByteLength <= MAX_BUNDLE_PAYLOAD_BYTES &&
    isSha256(value.payloadSha256) && isSha256(value.compiledArtifactId) && isStrictProvenance(value.provenance) &&
    isString(summary.feedId) && summary.timeZone === "Europe/Berlin" && isStrictDateRange(summary.serviceDateRange) &&
    isSafeInteger(summary.maximumServiceDayTimeSeconds) && isStrictSearchStartBounds(summary.searchStartBounds) &&
    isRecord(counts) && hasExactKeys(counts, ["routes", "trips", "stationAreas", "calendars", "exceptions", "connections"]) &&
    Object.values(counts).every((count) => isSafeInteger(count) && count >= 0);
}

function isSafeBundlePayloadFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === basename(value) && value === value.trim() && !value.includes("\u0000") && !value.includes("/") && !value.includes("\\") && value.endsWith(".v8.bin");
}

function isCompilerVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() &&
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 0x20 && code <= 0x7e;
    });
}

function isStrictProvenance(value: unknown): value is ScheduledRoutingArtifact["provenance"] {
  if (!isRecord(value) || !hasExactKeys(value, ["hashAlgorithm", "contentHash", "feedId", "timeZone", "files", "acquisition", "compiledArtifactId"]) ||
    value.hashAlgorithm !== "sha256" || !isSha256(value.contentHash) || !isString(value.feedId) || value.timeZone !== "Europe/Berlin" || !isSha256(value.compiledArtifactId) || !Array.isArray(value.files) ||
    !value.files.every((file) => isRecord(file) && hasExactKeys(file, ["fileName", "sha256", "byteLength"]) && isString(file.fileName) && isSha256(file.sha256) && isSafeInteger(file.byteLength) && file.byteLength >= 0)) return false;
  const acquisition = value.acquisition;
  if (!isRecord(acquisition) || !hasExactKeys(acquisition, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"])) return false;
  const license = acquisition.officialLicense;
  const officialProvenance = acquisition.officialProvenance;
  return isString(acquisition.sourceUrl) && isString(acquisition.retrievedAt) && isSafeInteger(acquisition.rawArchiveByteSize) && acquisition.rawArchiveByteSize >= 0 &&
    isSha256(acquisition.rawArchiveSha256) && isString(acquisition.feedVersion) && isDateString(acquisition.feedValidFrom) && isDateString(acquisition.feedValidUntil) &&
    isString(acquisition.attribution) && isString(acquisition.officialAttribution) && isRecord(license) && hasExactKeys(license, ["name", "url"]) && isString(license.name) && isString(license.url) &&
    isRecord(officialProvenance) && hasExactKeys(officialProvenance, ["source", "policyId"]) &&
    (officialProvenance.source === "feed" || officialProvenance.source === "meeet-policy") &&
    (officialProvenance.policyId === null || officialProvenance.policyId === "mvv-cc-by-4.0-fallback/v1");
}

function isStrictDateRange(value: unknown): value is { readonly firstDate: string; readonly lastDate: string } {
  return isRecord(value) && hasExactKeys(value, ["firstDate", "lastDate"]) && isDateRange(value);
}

function isStrictSearchStartBounds(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["earliestEpochSeconds", "latestEpochSeconds", "earliestAt", "latestAt", "maximumServiceDayTimeSeconds"]) && isSearchStartBounds(value);
}

function isScheduledArtifactCore(value: unknown): value is ScheduledArtifactCore {
  return isRecord(value) &&
    hasExactKeys(value, ["contractVersion", "feedId", "timeZone", "maximumServiceDayTimeSeconds", "searchStartBounds", "serviceDateRange", "routes", "trips", "stationAreas", "calendars", "exceptions", "connections"]) &&
    value.contractVersion === SCHEDULED_ROUTING_CONTRACT_VERSION &&
    isString(value.feedId) && value.timeZone === "Europe/Berlin" && isSafeInteger(value.maximumServiceDayTimeSeconds) &&
    isSearchStartBounds(value.searchStartBounds) && isDateRange(value.serviceDateRange) &&
    Array.isArray(value.routes) && Array.isArray(value.trips) && Array.isArray(value.stationAreas) && Array.isArray(value.calendars) && Array.isArray(value.exceptions) && Array.isArray(value.connections);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function bundleSummary(core: ScheduledArtifactCore): ScheduledBundleSummary {
  return {
    feedId: core.feedId,
    timeZone: core.timeZone,
    serviceDateRange: core.serviceDateRange,
    maximumServiceDayTimeSeconds: core.maximumServiceDayTimeSeconds,
    searchStartBounds: core.searchStartBounds,
    counts: {
      routes: core.routes.length,
      trips: core.trips.length,
      stationAreas: core.stationAreas.length,
      calendars: core.calendars.length,
      exceptions: core.exceptions.length,
      connections: core.connections.length,
    },
  };
}

function validateBundleSummary(summary: ScheduledBundleSummary, core: ScheduledArtifactCore): void {
  const expected = bundleSummary(core);
  if (summary.feedId !== expected.feedId || summary.timeZone !== expected.timeZone || summary.maximumServiceDayTimeSeconds !== expected.maximumServiceDayTimeSeconds ||
    summary.serviceDateRange.firstDate !== expected.serviceDateRange.firstDate || summary.serviceDateRange.lastDate !== expected.serviceDateRange.lastDate ||
    summary.searchStartBounds.earliestEpochSeconds !== expected.searchStartBounds.earliestEpochSeconds || summary.searchStartBounds.latestEpochSeconds !== expected.searchStartBounds.latestEpochSeconds ||
    summary.searchStartBounds.earliestAt !== expected.searchStartBounds.earliestAt || summary.searchStartBounds.latestAt !== expected.searchStartBounds.latestAt ||
    summary.searchStartBounds.maximumServiceDayTimeSeconds !== expected.searchStartBounds.maximumServiceDayTimeSeconds ||
    Object.keys(expected.counts).some((key) => summary.counts[key as keyof ScheduledBundleCounts] !== expected.counts[key as keyof ScheduledBundleCounts])) {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact manifest summary does not match its payload.");
  }
}

function validateRawArchive(artifact: ScheduledRoutingArtifact, rawArchiveBytes: Uint8Array | undefined): void {
  if (rawArchiveBytes !== undefined && (
    rawArchiveBytes.byteLength !== artifact.provenance.acquisition.rawArchiveByteSize ||
    sha256Bytes(rawArchiveBytes) !== artifact.provenance.acquisition.rawArchiveSha256
  )) throw new ScheduleArtifactUnavailableError("The configured scheduled artifact raw archive provenance does not match.");
}

function currentNodeMajor(): number {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isSafeInteger(major) || major <= 0) throw new ScheduleArtifactUnavailableError("The running Node version has no valid major number for scheduled artifact loading.");
  return major;
}

function defaultLoaderNow(): string {
  return new Date(Math.trunc(Date.now() / 1_000) * 1_000).toISOString();
}

function extractGtfsTextFiles(path: string): GtfsFeedFiles {
  let names: string[];
  try {
    names = execFileSync("unzip", ["-Z1", path], {
      encoding: "utf8",
      maxBuffer: MAX_GTFS_ARCHIVE_LIST_BYTES,
    }).split(/\r?\n/).filter((name) => name.toLowerCase().endsWith(".txt"));
  } catch {
    throw new ScheduleArtifactUnavailableError("The offline compiler requires the system unzip command.");
  }
  const files: Record<string, string> = {};
  const entriesByBasename = new Map<string, string>();
  for (const entry of names) {
    const fileName = secureArchiveBasename(entry);
    if (entriesByBasename.has(fileName)) {
      throw new ScheduleArtifactUnavailableError(`The MVV archive contains duplicate GTFS basename ${fileName}.`);
    }
    entriesByBasename.set(fileName, entry);
  }
  for (const [fileName, entry] of entriesByBasename) {
    try {
      files[fileName] = execFileSync("unzip", ["-p", path, entry], {
        encoding: "utf8",
        maxBuffer: MAX_GTFS_TEXT_FILE_BYTES,
      });
    } catch {
      throw new ScheduleArtifactUnavailableError(`The MVV archive could not extract ${fileName}; its output exceeded the compiler limit or was unreadable.`);
    }
  }
  return files;
}

function secureArchiveBasename(entry: string): string {
  const normalized = entry.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || normalized.includes("\u0000") || segments.some((segment) => segment === "..")) {
    throw new ScheduleArtifactUnavailableError("The MVV archive contains an unsafe GTFS path.");
  }
  const fileName = basename(normalized);
  if (fileName === "" || fileName === "." || fileName !== fileName.trim() || fileName.includes("\u0000")) {
    throw new ScheduleArtifactUnavailableError("The MVV archive contains an unsafe GTFS basename.");
  }
  return fileName;
}

interface FeedInfo {
  readonly publisherName: string;
  readonly publisherUrl: string;
  readonly feedVersion: string;
  readonly feedValidFrom: string;
  readonly feedValidUntil: string;
  readonly licenseName: string | null;
  readonly licenseUrl: string | null;
}

interface OfficialFeedMetadata {
  readonly attribution: string;
  readonly license: {
    readonly name: string;
    readonly url: string;
  };
  readonly provenance: GtfsAcquisitionRecord["officialProvenance"];
}

function parseFeedInfo(value: string | undefined): FeedInfo {
  if (value === undefined) throw new ScheduleArtifactUnavailableError("feed_info.txt is required for compiled schedule provenance.");
  const rows = parseCsv(value);
  const headers = rows[0];
  const row = rows[1];
  if (headers === undefined || row === undefined || rows.length !== 2) throw new ScheduleArtifactUnavailableError("feed_info.txt must contain exactly one metadata row.");
  const fields = new Map<string, string>();
  headers.forEach((header, index) => fields.set(header.replace(/^\uFEFF/, "").trim(), row[index] ?? ""));
  const publisherName = fields.get("feed_publisher_name")?.trim();
  const publisherUrl = fields.get("feed_publisher_url")?.trim();
  const feedVersion = fields.get("feed_version")?.trim();
  const feedValidFrom = normalizeFeedDate(fields.get("feed_start_date"));
  const feedValidUntil = normalizeFeedDate(fields.get("feed_end_date"));
  if (!publisherName || !publisherUrl || !feedVersion || !feedValidFrom || !feedValidUntil) throw new ScheduleArtifactUnavailableError("feed_info.txt is missing required publisher, version, or validity metadata.");
  if (!/^https:\/\//.test(publisherUrl)) throw new ScheduleArtifactUnavailableError("feed_info.txt publisher URL must use HTTPS.");
  return {
    publisherName,
    publisherUrl,
    feedVersion,
    feedValidFrom,
    feedValidUntil,
    licenseName: fields.get("feed_license")?.trim() || null,
    licenseUrl: fields.get("feed_license_url")?.trim() || null,
  };
}

function parseOfficialAttribution(value: string | undefined, feedInfo: FeedInfo): OfficialFeedMetadata {
  const feedProvided = parseFeedProvidedOfficialMetadata(feedInfo);
  if (value === undefined) {
    if (feedProvided !== null) return feedProvided;
    return {
      attribution: OFFICIAL_MVV_ATTRIBUTION,
      license: { name: "CC BY 4.0", url: DEFAULT_CC_BY_4_LICENSE_URL },
      provenance: { source: "meeet-policy", policyId: MVV_ATTRIBUTION_POLICY_ID },
    };
  }
  const rows = parseCsv(value);
  const headers = rows[0];
  if (headers === undefined || rows.length < 2) throw new ScheduleArtifactUnavailableError("attributions.txt must contain official attribution data.");
  const officialRows = rows.slice(1).filter((row) => {
    const fields = new Map<string, string>();
    headers.forEach((header, index) => fields.set(header.replace(/^\uFEFF/, "").trim(), row[index] ?? ""));
    const organization = fields.get("organization_name")?.trim() ?? "";
    return organization === OFFICIAL_MVV_ATTRIBUTION;
  });
  if (officialRows.length === 0) throw new ScheduleArtifactUnavailableError("Official MVV attribution and CC-BY license metadata were not found in attributions.txt.");
  let selected: OfficialFeedMetadata | null = null;
  for (const row of officialRows) {
    const fields = new Map<string, string>();
    headers.forEach((header, index) => fields.set(header.replace(/^\uFEFF/, "").trim(), row[index] ?? ""));
    const allText = [...fields.values()].join(" ");
    if (!/CC\s*[- ]?BY(?:\s*4(?:\.0)?)?/i.test(allText)) throw new ScheduleArtifactUnavailableError("attributions.txt contains conflicting official MVV license metadata.");
    const licenseUrl = fields.get("attribution_url")?.trim() || DEFAULT_CC_BY_4_LICENSE_URL;
    if (!/^https:\/\//.test(licenseUrl)) throw new ScheduleArtifactUnavailableError("The official MVV attribution license URL must use HTTPS.");
    const candidate: OfficialFeedMetadata = {
      attribution: OFFICIAL_MVV_ATTRIBUTION,
      license: { name: extractCcByLicenseName(allText), url: licenseUrl },
      provenance: { source: "feed", policyId: null },
    };
    if (selected !== null && (selected.license.name !== candidate.license.name || selected.license.url !== candidate.license.url)) throw new ScheduleArtifactUnavailableError("attributions.txt contains conflicting official MVV license metadata.");
    selected = candidate;
  }
  if (selected === null) throw new ScheduleArtifactUnavailableError("Official MVV attribution and CC-BY license metadata were not found in attributions.txt.");
  if (feedProvided !== null && (feedProvided.license.name !== selected.license.name || feedProvided.license.url !== selected.license.url)) throw new ScheduleArtifactUnavailableError("feed_info.txt and attributions.txt contain conflicting official license metadata.");
  return selected;
}

function parseFeedProvidedOfficialMetadata(feedInfo: FeedInfo): OfficialFeedMetadata | null {
  const hasFeedLicenseMetadata = feedInfo.licenseName !== null || feedInfo.licenseUrl !== null;
  if (!hasFeedLicenseMetadata) return null;
  if (feedInfo.publisherName !== OFFICIAL_MVV_ATTRIBUTION || !feedInfo.licenseName || !/CC\s*[- ]?BY/i.test(feedInfo.licenseName) || !feedInfo.licenseUrl?.startsWith("https://")) throw new ScheduleArtifactUnavailableError("feed_info.txt contains malformed or conflicting official license metadata.");
  return {
    attribution: feedInfo.publisherName,
    license: { name: feedInfo.licenseName, url: feedInfo.licenseUrl },
    provenance: { source: "feed", policyId: null },
  };
}

function extractCcByLicenseName(value: string): string {
  const match = /CC\s*[- ]?BY(?:\s*4(?:\.0)?)?/i.exec(value);
  return match?.[0].replace(/\s+/g, " ").replace(/CC[- ]BY/i, "CC BY") || "CC BY 4.0";
}

function normalizeFeedDate(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (quoted) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, "").trim());
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new ScheduleArtifactUnavailableError("GTFS metadata contains an unclosed quoted CSV field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, "").trim());
    rows.push(row);
  }
  return rows;
}

function isScheduledFeedValidityOutOfDate(acquisition: GtfsAcquisitionRecord, nowValue: string): boolean {
  let nowEpochSeconds: number;
  try {
    nowEpochSeconds = parseOffsetInstant(nowValue, "Europe/Berlin").epochSeconds;
  } catch {
    return true;
  }
  const localDate = berlinLocalDate(nowEpochSeconds);
  return localDate < acquisition.feedValidFrom || localDate > acquisition.feedValidUntil;
}

function berlinLocalDate(nowEpochSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowEpochSeconds * 1_000));
}

function validateFreshness(acquisition: GtfsAcquisitionRecord, nowValue: string): void {
  if (!isScheduledFeedValidityOutOfDate(acquisition, nowValue)) return;
  let nowEpochSeconds: number;
  try {
    nowEpochSeconds = parseOffsetInstant(nowValue, "Europe/Berlin").epochSeconds;
  } catch {
    throw new ScheduleArtifactUnavailableError("The configured scheduled artifact freshness check has an invalid clock instant.");
  }
  const localDate = berlinLocalDate(nowEpochSeconds);
  if (localDate < acquisition.feedValidFrom) throw new ScheduleArtifactUnavailableError("The configured scheduled artifact feed validity has not started.");
  throw new ScheduleArtifactUnavailableError("The configured scheduled artifact feed validity has expired.");
}

function isScheduledRoutingArtifact(value: unknown): value is ScheduledRoutingArtifact {
  if (!isRecord(value)) return false;
  const provenance = value.provenance;
  if (
    value.contractVersion !== "meeet-scheduled-routing/v1" ||
    !isString(value.feedId) ||
    value.timeZone !== "Europe/Berlin" ||
    !isSafeInteger(value.maximumServiceDayTimeSeconds) ||
    value.maximumServiceDayTimeSeconds < 0 ||
    !isSearchStartBounds(value.searchStartBounds) ||
    !isDateRange(value.serviceDateRange) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.stationAreas) ||
    !Array.isArray(value.trips) ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.calendars) ||
    !Array.isArray(value.exceptions) ||
    !isExactRecordArray(value.routes, ["routeId", "shortName", "longName", "routeType"]) ||
    !isExactRecordArray(value.trips, ["tripId", "routeId", "serviceId", "headsign"]) ||
    !isExactRecordArray(value.stationAreas, ["id", "name", "coordinate", "mode"]) ||
    !isExactRecordArray(value.calendars, ["serviceId", "startDate", "endDate", "weekdays"]) ||
    !isExactRecordArray(value.exceptions, ["serviceId", "date", "exceptionType"]) ||
    !isExactRecordArray(value.connections, ["id", "tripId", "routeId", "serviceId", "fromStationAreaId", "toStationAreaId", "fromStopSequence", "toStopSequence", "departureTimeSeconds", "arrivalTimeSeconds", "pickupType", "dropOffType", "line"]) ||
    !isRecord(provenance)
  ) return false;
  const acquisition = provenance.acquisition;
  return (
    provenance.hashAlgorithm === "sha256" &&
    isSha256(provenance.contentHash) &&
    isString(provenance.feedId) &&
    provenance.timeZone === "Europe/Berlin" &&
    isExactRecordArray(provenance.files, ["fileName", "sha256", "byteLength"]) &&
    isSha256(provenance.compiledArtifactId) &&
    isRecord(acquisition) &&
    acquisition.sourceUrl === SCHEDULED_MVV_FEED_URL &&
    isString(acquisition.retrievedAt) &&
    isSafeInteger(acquisition.rawArchiveByteSize) &&
    acquisition.rawArchiveByteSize >= 0 &&
    isSha256(acquisition.rawArchiveSha256) &&
    isString(acquisition.feedVersion) &&
    isDateString(acquisition.feedValidFrom) &&
    isDateString(acquisition.feedValidUntil) &&
    isString(acquisition.attribution) &&
    isString(acquisition.officialAttribution) &&
    isRecord(acquisition.officialLicense) &&
    isString(acquisition.officialLicense.name) &&
    isString(acquisition.officialLicense.url) &&
    isRecord(acquisition.officialProvenance) &&
    (acquisition.officialProvenance.source === "feed" || acquisition.officialProvenance.source === "meeet-policy") &&
    (acquisition.officialProvenance.policyId === null || acquisition.officialProvenance.policyId === "mvv-cc-by-4.0-fallback/v1")
  );
}

function validateArtifactStructure(artifact: ScheduledRoutingArtifact): void {
  if ("boardingStops" in artifact) throw invalidArtifact("boarding stops");
  if (artifact.routes.some((route) => typeof route.routeId !== "string" || typeof route.shortName !== "string" || typeof route.longName !== "string") || artifact.trips.some((trip) => typeof trip.tripId !== "string" || typeof trip.routeId !== "string" || typeof trip.serviceId !== "string" || typeof trip.headsign !== "string") || artifact.stationAreas.some((area) => typeof area.id !== "string" || typeof area.name !== "string" || !isRecord(area.coordinate) || (area.mode !== "sbahn" && area.mode !== "ubahn" && area.mode !== "tram" && area.mode !== "bus") || "boardingStopIds" in area || "parentStationId" in area) || artifact.calendars.some((calendar) => typeof calendar.serviceId !== "string" || !Array.isArray(calendar.weekdays)) || artifact.exceptions.some((exception) => typeof exception.serviceId !== "string" || typeof exception.date !== "string") || artifact.connections.some((connection) => typeof connection.id !== "string" || typeof connection.tripId !== "string" || typeof connection.routeId !== "string" || typeof connection.serviceId !== "string" || "fromStopId" in connection || "toStopId" in connection || typeof connection.fromStationAreaId !== "string" || typeof connection.toStationAreaId !== "string" || !isRecord(connection.line))) throw invalidArtifact("nested field type");
  const routeIds = uniqueSorted(artifact.routes.map((route) => route.routeId), "routes");
  uniqueSorted(artifact.trips.map((trip) => trip.tripId), "trips");
  const areaIds = uniqueSorted(artifact.stationAreas.map((area) => area.id), "stationAreas");
  const serviceIds = new Set<string>([
    ...artifact.calendars.map((calendar) => calendar.serviceId),
    ...artifact.exceptions.map((exception) => exception.serviceId),
  ]);
  const routeIdSet = new Set(routeIds);
  const areaIdSet = new Set(areaIds);
  const routeById = new Map(artifact.routes.map((route) => [route.routeId, route]));
  const tripById = new Map(artifact.trips.map((trip) => [trip.tripId, trip]));
  uniqueSorted(artifact.calendars.map((calendar) => calendar.serviceId), "calendars");
  const connectionIds = new Set<string>();
  if (artifact.routes.some((route) => !Number.isSafeInteger(route.routeType) || route.routeType < 0 || route.routeType > 999)) throw invalidArtifact("route type");
  for (const area of artifact.stationAreas) {
    validateCoordinate(area.coordinate, "station area coordinate");
  }
  for (const trip of artifact.trips) {
    if (!routeIdSet.has(trip.routeId) || !serviceIds.has(trip.serviceId)) throw invalidArtifact("trip reference");
  }
  for (const calendar of artifact.calendars) {
    if (calendar.weekdays.length !== 7 || calendar.startDate > calendar.endDate || !isDateString(calendar.startDate) || !isDateString(calendar.endDate)) throw invalidArtifact("calendar");
  }
  const exceptionKeys = artifact.exceptions.map((exception) => `${exception.date}:${exception.serviceId}`);
  if (!isSortedUnique(exceptionKeys) || artifact.exceptions.some((exception) => !isDateString(exception.date) || (exception.exceptionType !== 1 && exception.exceptionType !== 2))) throw invalidArtifact("service exceptions");
  let maximumTime = 0;
  let previousConnection: ScheduledRoutingArtifact["connections"][number] | undefined;
  for (const connection of artifact.connections) {
    if (connectionIds.has(connection.id)) throw invalidArtifact("connection identities");
    connectionIds.add(connection.id);
    const trip = tripById.get(connection.tripId);
    const route = routeById.get(connection.routeId);
    if (trip === undefined || route === undefined || trip.routeId !== connection.routeId || trip.serviceId !== connection.serviceId || !areaIdSet.has(connection.fromStationAreaId) || !areaIdSet.has(connection.toStationAreaId) || connection.fromStopSequence >= connection.toStopSequence || connection.departureTimeSeconds < 0 || connection.arrivalTimeSeconds < connection.departureTimeSeconds || connection.pickupType < 0 || connection.pickupType > 1 || connection.dropOffType < 0 || connection.dropOffType > 1 || connection.line.routeId !== route.routeId || typeof connection.line.shortName !== "string" || typeof connection.line.longName !== "string") throw invalidArtifact("connection reference or timing");
    if (previousConnection !== undefined && compareScheduledConnections(previousConnection, connection) > 0) throw invalidArtifact("connection sort order");
    previousConnection = connection;
    maximumTime = Math.max(maximumTime, connection.departureTimeSeconds, connection.arrivalTimeSeconds);
  }
  if (maximumTime !== artifact.maximumServiceDayTimeSeconds) throw invalidArtifact("maximum service-day time");
  if (artifact.provenance.feedId !== artifact.feedId || artifact.provenance.timeZone !== artifact.timeZone) throw invalidArtifact("provenance identity");
  const fileNames = artifact.provenance.files.map((file) => file.fileName);
  if (!isSortedUnique(fileNames) || artifact.provenance.files.some((file) => !isSha256(file.sha256) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0)) throw invalidArtifact("file provenance");
  if (!artifact.provenance.acquisition.officialAttribution.includes(OFFICIAL_MVV_ATTRIBUTION) || !/CC\s*[- ]?BY/i.test(artifact.provenance.acquisition.officialLicense.name) || !artifact.provenance.acquisition.officialLicense.url.startsWith("https://") || (artifact.provenance.acquisition.officialProvenance.source === "feed" ? artifact.provenance.acquisition.officialProvenance.policyId !== null : artifact.provenance.acquisition.officialProvenance.policyId !== MVV_ATTRIBUTION_POLICY_ID)) throw invalidArtifact("official attribution provenance");
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  if (!isSortedUnique(values)) throw invalidArtifact(`${label} identity order`);
  return values;
}

function isSortedUnique(values: readonly string[]): boolean {
  if (values.some((value) => typeof value !== "string")) return false;
  for (let index = 1; index < values.length; index += 1) if (compareScheduledIds(values[index - 1] ?? "", values[index] ?? "") >= 0) return false;
  return true;
}

function validateCoordinate(value: { readonly latitude: number; readonly longitude: number }, label: string): void {
  if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) || value.latitude < -90 || value.latitude > 90 || value.longitude < -180 || value.longitude > 180) throw invalidArtifact(label);
}

function invalidArtifact(label: string): ScheduleArtifactUnavailableError {
  return new ScheduleArtifactUnavailableError(`The configured scheduled artifact failed structural validation: ${label}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year!, month! - 1, day!));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month! - 1 && candidate.getUTCDate() === day;
}

function isDateRange(value: unknown): value is { readonly firstDate: string; readonly lastDate: string } {
  return isRecord(value) && isDateString(value.firstDate) && isDateString(value.lastDate) && value.firstDate <= value.lastDate;
}

function isSearchStartBounds(value: unknown): boolean {
  return isRecord(value) &&
    isSafeInteger(value.earliestEpochSeconds) &&
    isSafeInteger(value.latestEpochSeconds) &&
    value.earliestEpochSeconds <= value.latestEpochSeconds &&
    isString(value.earliestAt) &&
    isString(value.latestAt) &&
    isSafeInteger(value.maximumServiceDayTimeSeconds);
}

function isExactRecordArray(value: unknown, requiredKeys: readonly string[]): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && hasExactKeys(entry, requiredKeys));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const child of value) deepFreeze(child);
    } else {
      for (const child of Object.values(value)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
