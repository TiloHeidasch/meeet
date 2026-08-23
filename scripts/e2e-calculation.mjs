// E2E functional calculation gate.
//
// Runs against a built and started meeet server (fixture provider mode with a
// freshly compiled fixture schedule artifact). It covers both public
// calculation transports and follows the stream reference into the station-
// area details endpoint. Plain Node ESM, no dependencies, no TypeScript.

const BASE_URL = process.env.MEEET_E2E_BASE_URL ?? "http://127.0.0.1:3000";
const CALCULATION_PROGRESS_CONTRACT_VERSION = "meeet-calculation-progress/v1";
const CALCULATION_PROGRESS_PHASES = [
  "access-seeds",
  "scheduled-routing",
  "station-area-evaluation",
  "validating-result",
];
const CHANGE_TIME_SECONDS = { quick: 180, medium: 300, long: 600 };
const WALKING_SECONDS_ROUNDING_RULE = "ceil(distanceMetres / velocityMetresPerSecond / 60) * 60, with zero distance taking zero seconds";
const REQUEST_TIMEOUT_MS = boundedInteger(process.env.MEEET_E2E_TIMEOUT_MS, 100_000, 1_000, 120_000);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const REQUEST = {
  contractVersion: "meeet-meeting/v3",
  participants: [
    { id: "red", origin: { label: "Red", latitude: 48.1374, longitude: 11.5755 }, mode: "transit" },
    { id: "blue", origin: { label: "Blue", latitude: 48.14, longitude: 11.57 }, mode: "transit" },
  ],
  tolerancePercent: 10,
  changeTimePreset: "medium",
  searchStartAt: new Date(Math.floor((Date.now() + 5 * 60 * 1000) / 1000) * 1000).toISOString(),
};

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function fail(assertion, detail) {
  console.error(`E2E FAILED: ${assertion}`);
  if (detail !== undefined) {
    console.error(detail instanceof Error ? detail.message : JSON.stringify(detail, null, 2));
  }
  process.exit(1);
}

function check(condition, assertion, detail) {
  if (!condition) fail(assertion, detail);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isWholeMinute(value) {
  return Number.isSafeInteger(value) && value >= 0 && value % 60 === 0;
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sameValue(first, second) {
  return JSON.stringify(canonical(first)) === JSON.stringify(canonical(second));
}

function canonicalSearchStartAt(value) {
  const epoch = Date.parse(value);
  return new Date(Math.ceil(epoch / 60_000) * 60_000).toISOString();
}

function expectedArrival(searchStartAt, totalSeconds) {
  return new Date(Date.parse(searchStartAt) + totalSeconds * 1_000).toISOString();
}

function endpoint(path) {
  return new URL(path, BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`).toString();
}

async function readResponseBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  check(!Number.isFinite(declaredLength) || declaredLength <= MAX_RESPONSE_BYTES, "response content-length is bounded", declaredLength);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      check(bytes <= MAX_RESPONSE_BYTES, "response body is bounded", `${bytes} bytes`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function postJson(path, body, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (typeof timeout.unref === "function") timeout.unref();
  try {
    const response = await fetch(endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response, text: await readResponseBody(response) };
  } catch (error) {
    fail(`POST ${path} completes within ${REQUEST_TIMEOUT_MS}ms`, error);
  } finally {
    clearTimeout(timeout);
  }
}

function expectStatus(result, expected, assertion) {
  check(result.response.status === expected, `${assertion} (got ${result.response.status})`, result.text);
}

function parseJson(text, assertion) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${assertion} is valid JSON`, error);
  }
}

function validateCoordinate(value, assertion) {
  check(hasExactKeys(value, ["latitude", "longitude"]), `${assertion} has latitude and longitude`, value);
  check(isFiniteNumber(value.latitude) && value.latitude >= -90 && value.latitude <= 90, `${assertion}.latitude is valid`, value.latitude);
  check(isFiniteNumber(value.longitude) && value.longitude >= -180 && value.longitude <= 180, `${assertion}.longitude is valid`, value.longitude);
}

function validateStationMarker(marker, assertion) {
  check(hasExactKeys(marker, ["stationAreaId", "name", "coordinate", "mode", "classification", "redArrivalSeconds", "blueArrivalSeconds", "fasterParticipant", "withinSelectedTolerance"]), `${assertion} has the v3 station-area fields`, marker);
  check(isNonEmptyString(marker.stationAreaId), `${assertion}.stationAreaId is non-empty`, marker.stationAreaId);
  check(isNonEmptyString(marker.name), `${assertion}.name is non-empty`, marker.name);
  validateCoordinate(marker.coordinate, `${assertion}.coordinate`);
  check(["sbahn", "ubahn", "tram", "bus"].includes(marker.mode), `${assertion}.mode is valid`, marker.mode);
  check(["red", "blue", "fair", "unclassified"].includes(marker.classification), `${assertion}.classification is valid`, marker.classification);
  check(marker.redArrivalSeconds === null || isWholeMinute(marker.redArrivalSeconds), `${assertion}.redArrivalSeconds is a whole minute or null`, marker.redArrivalSeconds);
  check(marker.blueArrivalSeconds === null || isWholeMinute(marker.blueArrivalSeconds), `${assertion}.blueArrivalSeconds is a whole minute or null`, marker.blueArrivalSeconds);
  check(marker.fasterParticipant === null || marker.fasterParticipant === "red" || marker.fasterParticipant === "blue", `${assertion}.fasterParticipant is valid`, marker.fasterParticipant);
  check(typeof marker.withinSelectedTolerance === "boolean", `${assertion}.withinSelectedTolerance is boolean`, marker.withinSelectedTolerance);
}

function validateV3Calculation(body, assertion) {
  check(hasExactKeys(body, ["contractVersion", "status", "reason", "participants", "stationAreas", "metadata"]), `${assertion} has the v3 response fields`, body);
  check(body.contractVersion === "meeet-meeting/v3", `${assertion}.contractVersion is meeet-meeting/v3`, body.contractVersion);
  check(body.status === "ok", `${assertion}.status is ok`, body.status);
  check(body.reason === null, `${assertion}.reason is null`, body.reason);
  check(Array.isArray(body.participants) && body.participants.length === 2, `${assertion}.participants has length 2`, body.participants);
  check(body.participants[0]?.color === "red" && body.participants[1]?.color === "blue", `${assertion}.participants are ordered red/blue`, body.participants);
  check(Array.isArray(body.stationAreas) && body.stationAreas.length > 0, `${assertion}.stationAreas is non-empty`, body.stationAreas);
  check(isObject(body.metadata), `${assertion}.metadata is an object`, body.metadata);

  const ids = new Set();
  for (const [index, marker] of body.stationAreas.entries()) {
    validateStationMarker(marker, `${assertion}.stationAreas[${index}]`);
    check(!ids.has(marker.stationAreaId), `${assertion}.stationAreaIds are unique`, marker.stationAreaId);
    ids.add(marker.stationAreaId);
  }
  return body;
}

function parseSseFrames(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  check(normalized.endsWith("\n\n"), "SSE stream ends with a blank line");
  const frames = [];
  for (const raw of normalized.split("\n\n")) {
    if (raw === "") continue;
    let event;
    const data = [];
    let hasComment = false;
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) {
        hasComment = true;
        continue;
      }
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (event === undefined && data.length === 0 && hasComment) continue;
    check(typeof event === "string" && event !== "", "SSE frame has an event name", raw);
    check(data.length === 1, `SSE ${event} frame has exactly one data line`, raw);
    frames.push({ event, data: data[0] });
  }
  return frames;
}

function validateProgressFrame(frame, index) {
  const data = parseJson(frame.data, `SSE progress[${index}] data`);
  check(hasExactKeys(data, ["contractVersion", "phase"]), `SSE progress[${index}] has the progress fields`, data);
  check(data.contractVersion === CALCULATION_PROGRESS_CONTRACT_VERSION, `SSE progress[${index}] has the progress contract version`, data.contractVersion);
  check(data.phase === CALCULATION_PROGRESS_PHASES[index], `SSE progress phase ${index + 1} is ordered`, data.phase);
}

function validateStationVerdictFrame(frame, index) {
  const data = parseJson(frame.data, `SSE station-verdict[${index}] data`);
  const allowedKeys = ["contractVersion", "stationAreaId", "name", "coordinate", "verdict", "mode"];
  const requiredKeys = ["contractVersion", "stationAreaId", "name", "coordinate", "verdict"];
  check(isObject(data) && Object.keys(data).every((key) => allowedKeys.includes(key)) && requiredKeys.every((key) => Object.hasOwn(data, key)), `SSE station-verdict[${index}] has the progress fields`, data);
  check(data.contractVersion === CALCULATION_PROGRESS_CONTRACT_VERSION, `SSE station-verdict[${index}] has the progress contract version`, data.contractVersion);
  check(isNonEmptyString(data.stationAreaId), `SSE station-verdict[${index}].stationAreaId is non-empty`, data.stationAreaId);
  check(isNonEmptyString(data.name), `SSE station-verdict[${index}].name is non-empty`, data.name);
  validateCoordinate(data.coordinate, `SSE station-verdict[${index}].coordinate`);
  check(["red", "blue", "fair", "unclassified"].includes(data.verdict), `SSE station-verdict[${index}].verdict is valid`, data.verdict);
  check(data.mode === undefined || ["sbahn", "ubahn", "tram", "bus"].includes(data.mode), `SSE station-verdict[${index}].mode is valid when present`, data.mode);
  return data;
}

function validateCalculationStream(text) {
  const frames = parseSseFrames(text);
  const events = frames.map((frame) => frame.event);
  const terminal = frames.filter((frame) => frame.event === "result" || frame.event === "error");
  check(terminal.length === 1, "SSE has exactly one terminal event", events);
  check(terminal[0].event === "result", "SSE terminal event is result and not error", terminal[0]);
  check(!events.includes("error"), "SSE contains no error event", events);
  check(events.every((event) => ["progress", "station-verdict", "ref", "result"].includes(event)), "SSE contains only known calculation events", events);

  const progressFrames = frames.filter((frame) => frame.event === "progress");
  check(progressFrames.length === CALCULATION_PROGRESS_PHASES.length, "SSE has all ordered progress phases", progressFrames);
  progressFrames.forEach(validateProgressFrame);
  check(frames[0].event === "progress", "SSE starts with the first progress phase", events);

  const verdictFrames = frames.filter((frame) => frame.event === "station-verdict");
  const verdicts = verdictFrames.map(validateStationVerdictFrame);
  const verdictIds = new Set(verdicts.map((verdict) => verdict.stationAreaId));
  check(verdictIds.size === verdicts.length, "SSE station verdict ids are unique", verdicts);

  const evaluationIndex = frames.findIndex((frame) => frame.event === "progress" && parseJson(frame.data, "SSE station-area-evaluation data").phase === "station-area-evaluation");
  const validatingIndex = frames.findIndex((frame) => frame.event === "progress" && parseJson(frame.data, "SSE validating-result data").phase === "validating-result");
  check(evaluationIndex !== -1 && validatingIndex !== -1 && evaluationIndex < validatingIndex, "SSE progress phases bracket station verdicts", events);
  for (const frame of verdictFrames) {
    const index = frames.indexOf(frame);
    check(index > evaluationIndex && index < validatingIndex, "SSE station verdicts are between evaluation phases", frame);
  }

  const refFrames = frames.filter((frame) => frame.event === "ref");
  check(refFrames.length === 1, "SSE has exactly one calculation reference", refFrames);
  const ref = parseJson(refFrames[0].data, "SSE ref data");
  check(hasExactKeys(ref, ["calculationRef"]) && isNonEmptyString(ref.calculationRef), "SSE calculation reference is non-empty", ref);
  const resultIndex = frames.findIndex((frame) => frame.event === "result");
  check(validatingIndex < frames.indexOf(refFrames[0]) && frames.indexOf(refFrames[0]) < resultIndex && resultIndex === frames.length - 1, "SSE reference follows progress and precedes the terminal result", events);

  const result = validateV3Calculation(parseJson(terminal[0].data, "SSE result data"), "SSE result");
  check(verdicts.length === result.stationAreas.length, "SSE has one station verdict per returned station area", verdicts);
  for (const marker of result.stationAreas) {
    const verdict = verdicts.find((candidate) => candidate.stationAreaId === marker.stationAreaId);
    check(verdict !== undefined, "SSE station verdict matches a returned station area", marker.stationAreaId);
    check(verdict.name === marker.name && sameValue(verdict.coordinate, marker.coordinate) && verdict.verdict === marker.classification && (verdict.mode === undefined || verdict.mode === marker.mode), "SSE station verdict matches returned station-area identity", verdict);
  }
  return { result, calculationRef: ref.calculationRef };
}

function validateSchedule(schedule, assertion) {
  check(hasExactKeys(schedule, ["contractVersion", "feedId", "timeZone", "scheduleContentHash", "compiledArtifactId", "serviceDateRange", "acquisition"]), `${assertion} has schedule provenance fields`, schedule);
  check(schedule.contractVersion === "meeet-scheduled-routing/v1", `${assertion}.contractVersion is valid`, schedule.contractVersion);
  for (const field of ["feedId", "timeZone", "scheduleContentHash", "compiledArtifactId"]) check(isNonEmptyString(schedule[field]), `${assertion}.${field} is non-empty`, schedule[field]);
  check(hasExactKeys(schedule.serviceDateRange, ["firstDate", "lastDate"]) && /^\d{4}-\d{2}-\d{2}$/.test(schedule.serviceDateRange.firstDate) && /^\d{4}-\d{2}-\d{2}$/.test(schedule.serviceDateRange.lastDate) && schedule.serviceDateRange.firstDate <= schedule.serviceDateRange.lastDate, `${assertion}.serviceDateRange is valid`, schedule.serviceDateRange);
  const acquisition = schedule.acquisition;
  check(hasExactKeys(acquisition, ["sourceUrl", "retrievedAt", "rawArchiveByteSize", "rawArchiveSha256", "feedVersion", "feedValidFrom", "feedValidUntil", "attribution", "officialAttribution", "officialLicense", "officialProvenance"]), `${assertion}.acquisition has provenance fields`, acquisition);
  for (const field of ["sourceUrl", "retrievedAt", "rawArchiveSha256", "feedVersion", "attribution", "officialAttribution"]) check(isNonEmptyString(acquisition[field]), `${assertion}.acquisition.${field} is non-empty`, acquisition[field]);
  check(Number.isSafeInteger(acquisition.rawArchiveByteSize) && acquisition.rawArchiveByteSize >= 0, `${assertion}.acquisition.rawArchiveByteSize is valid`, acquisition.rawArchiveByteSize);
  check(/^\d{4}-\d{2}-\d{2}$/.test(acquisition.feedValidFrom) && /^\d{4}-\d{2}-\d{2}$/.test(acquisition.feedValidUntil) && acquisition.feedValidFrom <= acquisition.feedValidUntil, `${assertion}.acquisition feed validity is valid`, acquisition);
  check(hasExactKeys(acquisition.officialLicense, ["name", "url"]) && isNonEmptyString(acquisition.officialLicense.name) && isNonEmptyString(acquisition.officialLicense.url), `${assertion}.acquisition.officialLicense is valid`, acquisition.officialLicense);
  check(hasExactKeys(acquisition.officialProvenance, ["source", "policyId"]) && ["feed", "meeet-policy"].includes(acquisition.officialProvenance.source) && (acquisition.officialProvenance.policyId === null || acquisition.officialProvenance.policyId === "mvv-cc-by-4.0-fallback/v1"), `${assertion}.acquisition.officialProvenance is valid`, acquisition.officialProvenance);
}

function validateAccessProvider(provider, assertion) {
  check(hasExactKeys(provider, ["name", "deployment", "dataKind", "liveData", "asOf", "notes", "provenance"]), `${assertion} has provider fields`, provider);
  check(isNonEmptyString(provider.name) && ["fixture", "self-hosted", "managed", "unknown"].includes(provider.deployment) && ["access", "demo-static"].includes(provider.dataKind) && provider.liveData === false && isNonEmptyString(provider.asOf) && isNonEmptyString(provider.notes), `${assertion} is non-live access metadata`, provider);
  const provenance = provider.provenance;
  check(hasExactKeys(provenance, ["role", "provider", "deployment", "dataKind", "liveData", "sourceUrl", "license", "attribution", "version", "retrievedAt", "notes", "feeds"]), `${assertion}.provenance has fields`, provenance);
  check(provenance.role === "access" && provenance.deployment === provider.deployment && provenance.dataKind === provider.dataKind && provenance.liveData === false && isNonEmptyString(provenance.provider) && isNonEmptyString(provenance.version) && provenance.version === provider.asOf && provenance.feeds === null, `${assertion}.provenance is access-only`, provenance);
  check(provenance.sourceUrl === null || isNonEmptyString(provenance.sourceUrl), `${assertion}.provenance.sourceUrl is valid`, provenance.sourceUrl);
  check(provenance.license === null || (hasExactKeys(provenance.license, ["name", "url"]) && isNonEmptyString(provenance.license.name) && isNonEmptyString(provenance.license.url)), `${assertion}.provenance.license is valid`, provenance.license);
  for (const field of ["attribution", "version", "retrievedAt", "notes"]) check(isNonEmptyString(provenance[field]), `${assertion}.provenance.${field} is non-empty`, provenance[field]);
}

function validateItinerary(itinerary, assertion) {
  if (itinerary === null) return;
  check(Array.isArray(itinerary) && itinerary.length > 0, `${assertion} is null or non-empty`, itinerary);
  for (const [index, leg] of itinerary.entries()) {
    const prefix = `${assertion}[${index}]`;
    check(isObject(leg) && (leg.kind === "walk" || leg.kind === "transit"), `${prefix}.kind is valid`, leg);
    const keys = leg.kind === "walk"
      ? ["kind", "fromAreaId", "toAreaId", "fromAreaName", "toAreaName", "startEpochSeconds", "endEpochSeconds"]
      : ["kind", "fromAreaId", "toAreaId", "fromAreaName", "toAreaName", "line", "routeType", "headsign", "tripId", "startEpochSeconds", "endEpochSeconds"];
    check(hasExactKeys(leg, keys), `${prefix} has itinerary fields`, leg);
    check(isNonEmptyString(leg.toAreaId) && isNonEmptyString(leg.toAreaName), `${prefix} has a destination station area`, leg);
    if (leg.kind === "transit") check(isNonEmptyString(leg.fromAreaId) && isNonEmptyString(leg.fromAreaName) && isNonEmptyString(leg.line) && isNonEmptyString(leg.tripId) && isFiniteNumber(leg.routeType) && typeof leg.headsign === "string", `${prefix} has transit fields`, leg);
    check(Number.isSafeInteger(leg.startEpochSeconds) && Number.isSafeInteger(leg.endEpochSeconds) && leg.startEpochSeconds >= 0 && leg.endEpochSeconds >= leg.startEpochSeconds, `${prefix} has ordered epoch seconds`, leg);
  }
}

function validateStationAreaDetails(body, calculation, selected) {
  check(hasExactKeys(body, ["contractVersion", "status", "reason", "stationArea", "participants", "basis"]), "station-area details has the v1 response fields", body);
  check(body.contractVersion === "meeet-station-area-details/v1", "station-area details contractVersion is v1", body.contractVersion);
  check(body.status === calculation.status && body.status === "ok", "station-area details status matches the calculation", body.status);
  check(body.reason === calculation.reason && body.reason === null, "station-area details reason matches the calculation", body.reason);
  validateStationMarker(body.stationArea, "station-area details.stationArea");
  check(sameValue(body.stationArea, selected), "station-area details marker matches the returned station area", body.stationArea);
  check(Array.isArray(body.participants) && body.participants.length === 2, "station-area details has two participants", body.participants);

  const basis = body.basis;
  check(hasExactKeys(basis, ["contractVersion", "searchStartAt", "selectedTolerancePercent", "changeTimeSeconds", "routingHorizonSeconds", "walkingVelocityMetersPerSecond", "walkingSecondsRoundingRule", "transferRadiusMeters", "deterministicSelectionPolicy", "schedule", "accessProvider"]), "station-area details basis has the v1 fields", basis);
  check(basis.contractVersion === "meeet-meeting/v3", "station-area details basis identifies v3", basis.contractVersion);
  check(basis.searchStartAt === canonicalSearchStartAt(REQUEST.searchStartAt), "station-area details basis has the canonical search start", basis.searchStartAt);
  check(basis.selectedTolerancePercent === REQUEST.tolerancePercent && basis.changeTimeSeconds === CHANGE_TIME_SECONDS[REQUEST.changeTimePreset], "station-area details basis matches the request", basis);
  check(basis.routingHorizonSeconds === 86_400 && isFiniteNumber(basis.walkingVelocityMetersPerSecond) && basis.walkingVelocityMetersPerSecond > 0 && basis.walkingSecondsRoundingRule === WALKING_SECONDS_ROUNDING_RULE && isFiniteNumber(basis.transferRadiusMeters) && basis.transferRadiusMeters > 0 && basis.deterministicSelectionPolicy === "earliest-arrival/canonical-scan-first/v1", "station-area details basis routing metadata is valid", basis);
  validateSchedule(basis.schedule, "station-area details basis.schedule");
  validateAccessProvider(basis.accessProvider, "station-area details basis.accessProvider");
  check(sameValue(basis.schedule, calculation.metadata.schedule), "station-area details schedule matches the calculation", basis.schedule);
  check(sameValue(basis.accessProvider, calculation.metadata.accessProvider), "station-area details access provider matches the calculation", basis.accessProvider);

  const detailStart = basis.searchStartAt;
  for (const [index, participant] of body.participants.entries()) {
    const expected = REQUEST.participants[index];
    const expectedColor = index === 0 ? "red" : "blue";
    const expectedTotal = index === 0 ? selected.redArrivalSeconds : selected.blueArrivalSeconds;
    const available = expectedTotal !== null;
    check(hasExactKeys(participant, ["id", "color", "origin", "status", "unavailableReason", "terminal", "itinerary"]), `station-area details participant ${index} has the v1 fields`, participant);
    check(participant.id === expected.id && participant.color === expectedColor && sameValue(participant.origin, expected.origin), `station-area details participant ${index} matches the request`, participant);
    check(hasExactKeys(participant.terminal, ["totalSeconds", "arrivalAt"]), `station-area details participant ${index}.terminal has fields`, participant.terminal);
    validateItinerary(participant.itinerary, `station-area details participant ${index}.itinerary`);
    if (available) {
      check(participant.status === "available" && participant.unavailableReason === null, `station-area details participant ${index} is available`, participant);
      check(Array.isArray(participant.itinerary) && participant.itinerary.length > 0, `station-area details participant ${index} has a non-empty itinerary`, participant.itinerary);
      const searchStartEpochSeconds = Date.parse(detailStart) / 1_000;
      const firstLeg = participant.itinerary[0];
      const lastLeg = participant.itinerary[participant.itinerary.length - 1];
      check(firstLeg.startEpochSeconds === searchStartEpochSeconds, `station-area details participant ${index} itinerary starts at search start`, firstLeg);
      check(Math.abs(lastLeg.endEpochSeconds - (searchStartEpochSeconds + expectedTotal)) <= 60, `station-area details participant ${index} itinerary final arrival matches terminal`, lastLeg);
      check(participant.terminal.totalSeconds === expectedTotal && isNonEmptyString(participant.terminal.arrivalAt) && participant.terminal.arrivalAt === expectedArrival(detailStart, expectedTotal), `station-area details participant ${index} terminal matches the station marker`, participant.terminal);
    } else {
      const unavailableReason = body.status === "no-result" ? body.reason : selected.classification === "unclassified" ? "station-area-unclassified" : "station-area-unavailable-for-participant";
      check(participant.status === "unavailable" && participant.unavailableReason === unavailableReason, `station-area details participant ${index} has an unavailable reason`, participant);
      check(participant.terminal.totalSeconds === null && participant.terminal.arrivalAt === null && participant.itinerary === null, `station-area details participant ${index} has no unavailable itinerary`, participant);
    }
  }
}

const jsonCalculation = await postJson("/api/meeting/calculate", REQUEST);
expectStatus(jsonCalculation, 200, "JSON calculation HTTP status is 200");
check(jsonCalculation.response.headers.get("content-type")?.toLowerCase().includes("application/json"), "JSON calculation response is application/json");
const jsonBody = validateV3Calculation(parseJson(jsonCalculation.text, "JSON calculation response"), "JSON calculation");

const streamCalculation = await postJson("/api/meeting/calculate/stream", REQUEST);
expectStatus(streamCalculation, 200, "SSE calculation HTTP status is 200");
check(streamCalculation.response.headers.get("content-type")?.toLowerCase().includes("text/event-stream"), "SSE calculation response is text/event-stream");
const { result: streamBody, calculationRef } = validateCalculationStream(streamCalculation.text);

const selectedStationArea = streamBody.stationAreas.find((area) => area.redArrivalSeconds !== null && area.blueArrivalSeconds !== null);
check(selectedStationArea !== undefined, "SSE result has a station area reachable by both participants for details");
const detailsPath = `/api/meeting/station-areas/${encodeURIComponent(selectedStationArea.stationAreaId)}/details`;
const stationAreaDetails = await postJson(detailsPath, REQUEST, { "Meeet-Calculation-Ref": calculationRef });
expectStatus(stationAreaDetails, 200, "station-area details HTTP status is 200");
check(stationAreaDetails.response.headers.get("content-type")?.toLowerCase().includes("application/json"), "station-area details response is application/json");
validateStationAreaDetails(parseJson(stationAreaDetails.text, "station-area details response"), streamBody, selectedStationArea);

console.log(
  `E2E OK: JSON and SSE v3 calculations returned status "ok" with ${jsonBody.stationAreas.length} station areas; SSE ref and v1 station-area details validated for ${selectedStationArea.stationAreaId}`,
);
process.exit(0);
