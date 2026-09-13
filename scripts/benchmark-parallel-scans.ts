// Benchmark: shared-continuation-map pair scan vs two sequential scans (issue #75).
// Generates a large synthetic GTFS feed, builds one routing window, then times
// the scan phase only (window build is excluded and shared across both approaches).
import { performance } from "node:perf_hooks";
import {
  createScheduledRoutingWindow,
  importGtfsSchedule,
  routeScheduledEarliestArrivals,
  routeScheduledEarliestArrivalsPair,
  type GtfsFeedFiles,
  type ScheduledRoutingArtifact,
} from "../lib/domain/scheduled-routing/index.ts";

const ACQUISITION = {
  sourceUrl: "https://example.test/benchmark-feed.zip",
  retrievedAt: "2026-08-11T10:00:00Z",
  rawArchiveByteSize: 0,
  rawArchiveSha256: "a".repeat(64),
  feedVersion: "benchmark-2026-08",
  feedValidFrom: "2026-08-01",
  feedValidUntil: "2026-10-30",
  attribution: "Benchmark",
  officialAttribution: "Benchmark",
  officialLicense: { name: "Benchmark License", url: "https://example.test/license" },
  officialProvenance: { source: "feed", policyId: null } as const,
};

const GRID = Number(process.env.BENCH_GRID ?? 60);
const TRIP_COUNT = Number(process.env.BENCH_TRIPS ?? 240);
const SEARCH_START = "2026-08-11T08:05:00+02:00";
const WALKING_VELOCITY = 1.4;
const TRANSFER_RADIUS = 250;

function buildFeed(grid: number, tripCount: number): GtfsFeedFiles {
  const stops: string[] = ["stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station"];
  const trips: string[] = ["route_id,service_id,trip_id,trip_headsign"];
  const stopTimes: string[] = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type"];
  // 2D grid of station areas (real transit networks are 2D): each area has many
  // spatial neighbors within the transfer radius, so the per-drop-off spatial
  // query is the dominant scan cost and precomputing it once (shared across
  // both participant scans) is a meaningful saving.
  for (let r = 0; r < grid; r += 1) {
    for (let c = 0; c < grid; c += 1) {
      const id = `s${r}_${c}`;
      const lat = 48.1 + r * 0.0006;
      const lon = 11.5 + c * 0.0006;
      stops.push(`${id},Station ${r}-${c},${lat},${lon},1,`);
      stops.push(`${id}-1,Station ${r}-${c} platform,${lat},${lon},0,${id}`);
    }
  }
  for (let t = 0; t < tripCount; t += 1) {
    const tripId = `trip-${t}`;
    trips.push(`line,everyday,${tripId},End`);
    const baseSeconds = 4 * 3600 + Math.floor((t * (18 * 3600)) / tripCount);
    const row = t % grid;
    for (let c = 0; c < grid; c += 1) {
      const arrSec = baseSeconds + c * 60;
      const ah = String(Math.floor(arrSec / 3600)).padStart(2, "0");
      const am = String(Math.floor((arrSec % 3600) / 60)).padStart(2, "0");
      const arr = `${ah}:${am}:00`;
      stopTimes.push(`${tripId},${arr},${arr},s${row}_${c}-1,${c + 1},0,0`);
    }
  }
  return {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nbench,Benchmark,https://example.test,Europe/Berlin",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\nline,L,Line,1",
    "stops.txt": stops.join("\n"),
    "trips.txt": trips.join("\n"),
    "stop_times.txt": stopTimes.join("\n"),
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\neveryday,1,1,1,1,1,1,1,20260801,20261030",
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function main(): void {
  const artifact: ScheduledRoutingArtifact = importGtfsSchedule(buildFeed(GRID, TRIP_COUNT), {
    feedId: "benchmark-feed",
    timeZone: "Europe/Berlin",
    acquisition: ACQUISITION,
    logProgress: false,
  });
  const window = createScheduledRoutingWindow(artifact, SEARCH_START, {
    walkingVelocityMetersPerSecond: WALKING_VELOCITY,
    transferRadiusMeters: TRANSFER_RADIUS,
    changeTimeSeconds: 180,
  });
  const seedsA = [{ stationAreaId: "s0_0", accessSeconds: 0 }];
  const seedsB = [{ stationAreaId: `s${GRID - 1}_${GRID - 1}`, accessSeconds: 0 }];
  const opts = { walkingVelocityMetersPerSecond: WALKING_VELOCITY, transferRadiusMeters: TRANSFER_RADIUS, changeTimeSeconds: 180 };

  const WARMUP = 3;
  const SAMPLES = 7;
  const sequentialSamples: number[] = [];
  const pairSamples: number[] = [];

  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    const sStart = performance.now();
    const r1 = routeScheduledEarliestArrivals(artifact, seedsA, SEARCH_START, opts, window);
    const r2 = routeScheduledEarliestArrivals(artifact, seedsB, SEARCH_START, opts, window);
    const sEnd = performance.now();
    const pStart = performance.now();
    const [p1, p2] = routeScheduledEarliestArrivalsPair(artifact, [seedsA, seedsB], SEARCH_START, opts, window);
    const pEnd = performance.now();
    if (i >= WARMUP) {
      sequentialSamples.push(sEnd - sStart);
      pairSamples.push(pEnd - pStart);
    }
    if (i === WARMUP + SAMPLES - 1) {
      if (JSON.stringify(r1) !== JSON.stringify(p1) || JSON.stringify(r2) !== JSON.stringify(p2)) {
        throw new Error("Pair scan result diverged from two sequential scans — correctness regression.");
      }
    }
  }

  const seqMs = median(sequentialSamples);
  const pairMs = median(pairSamples);
  const speedup = seqMs / pairMs;
  console.log(`[bench] grid=${GRID} trips=${TRIP_COUNT} connections=${artifact.connections.length}`);
  console.log(`[bench] sequential (two scans) median: ${seqMs.toFixed(2)} ms`);
  console.log(`[bench] pair (shared continuation map) median: ${pairMs.toFixed(2)} ms`);
  console.log(`[bench] speedup: ${speedup.toFixed(2)}x`);
  if (pairMs > seqMs * 1.1) {
    throw new Error(`Pair scan was not faster (pair=${pairMs.toFixed(2)}ms > sequential*1.1=${(seqMs * 1.1).toFixed(2)}ms).`);
  }
  console.log("[bench] OK: pair scan is faster and results match.");
}

main();
