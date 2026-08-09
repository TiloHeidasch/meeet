/** Sanitized MVG coordinate-route capture for the Rießerseestraße 2 search. */
export const RIESSER_COORDINATE_ROUTE = {
  parts: [
    {
      from: {
        stationGlobalId: "",
        latitude: 48.11435,
        longitude: 11.51525,
        plannedDeparture: "2026-08-09T14:38:00.000Z",
      },
      to: {
        stationGlobalId: "de:09162:riesser-origin",
        name: "Rießerseestraße",
        latitude: 48.1145,
        longitude: 11.5155,
        plannedDeparture: "2026-08-09T14:45:00.000Z",
      },
      line: { transportType: "FUSS" },
      intermediateStops: [],
    },
    {
      from: {
        stationGlobalId: "de:09162:riesser-origin",
        name: "Rießerseestraße",
        latitude: 48.1145,
        longitude: 11.5155,
        plannedDeparture: "2026-08-09T14:44:00.000Z",
      },
      to: {
        stationGlobalId: "de:09162:schoenstation",
        name: "Schönstraße",
        latitude: 48.105,
        longitude: 11.5613,
        plannedDeparture: "2026-08-09T14:55:00.000Z",
      },
      line: { transportType: "BUS", name: "Bus 134" },
      intermediateStops: [],
    },
    {
      from: {
        stationGlobalId: "de:09162:schoenstation",
        name: "Schönstraße",
        latitude: 48.105,
        longitude: 11.5613,
        plannedDeparture: "2026-08-09T14:55:00.000Z",
      },
      to: {
        stationGlobalId: "",
        latitude: 48.10475,
        longitude: 11.5618,
        plannedDeparture: "2026-08-09T14:59:00.000Z",
      },
      line: { transportType: "FUSS" },
      intermediateStops: [],
    },
  ],
} as const;

/** Sanitized Hbf anchor capture with platform coordinates retained between stable station IDs. */
export const RIESSER_HBF_COORDINATE_ROUTE = {
  parts: [
    {
      from: {
        stationGlobalId: "",
        latitude: 48.11435,
        longitude: 11.51525,
        plannedDeparture: "2026-08-09T14:20:00.000Z",
      },
      to: {
        stationGlobalId: "de:09162:riesser-origin",
        name: "Rießerseestraße",
        latitude: 48.1145,
        longitude: 11.5155,
        plannedDeparture: "2026-08-09T14:30:00.000Z",
      },
      line: { transportType: "FUSS" },
      intermediateStops: [],
    },
    {
      from: {
        stationGlobalId: "de:09162:riesser-origin",
        name: "Rießerseestraße",
        latitude: 48.1145,
        longitude: 11.5155,
        plannedDeparture: "2026-08-09T14:30:00.000Z",
      },
      to: {
        stationGlobalId: "de:09162:1150",
        name: "Hauptbahnhof platform",
        latitude: 48.140,
        longitude: 11.560,
        plannedDeparture: "2026-08-09T14:40:00.000Z",
      },
      line: { transportType: "BUS", name: "Bus 134" },
      intermediateStops: [],
    },
    {
      from: {
        stationGlobalId: "de:09162:1150",
        name: "Hauptbahnhof platform",
        latitude: 48.14085,
        longitude: 11.5608,
        plannedDeparture: "2026-08-09T14:40:00.000Z",
      },
      to: {
        stationGlobalId: "de:09162:6",
        name: "Hauptbahnhof",
        latitude: 48.137,
        longitude: 11.575,
        plannedDeparture: "2026-08-09T14:47:00.000Z",
      },
      line: { transportType: "UBAHN", name: "U-Bahn" },
      intermediateStops: [],
    },
    {
      from: {
        stationGlobalId: "de:09162:6",
        name: "Hauptbahnhof",
        latitude: 48.1381,
        longitude: 11.5756,
        plannedDeparture: "2026-08-09T14:46:00.000Z",
      },
      to: {
        stationGlobalId: "",
        latitude: 48.10475,
        longitude: 11.5618,
        plannedDeparture: "2026-08-09T14:59:00.000Z",
      },
      line: { transportType: "FUSS" },
      intermediateStops: [],
    },
  ],
} as const;

function shiftedRiesserRoute(shiftMinutes: number) {
  const shiftMilliseconds = shiftMinutes * 60_000;
  const route = JSON.parse(JSON.stringify(RIESSER_COORDINATE_ROUTE)) as {
    parts: Array<{
      from: Record<string, unknown>;
      to: Record<string, unknown>;
      line: Record<string, unknown>;
      intermediateStops: unknown[];
    }>;
  };
  for (const part of route.parts) {
    for (const endpoint of [part.from, part.to]) {
      if (typeof endpoint.plannedDeparture === "string") {
        endpoint.plannedDeparture = new Date(
          Date.parse(endpoint.plannedDeparture) + shiftMilliseconds,
        ).toISOString();
      }
    }
  }
  return route;
}

function twoMinuteBusOverlapRiesserRoute() {
  const route = shiftedRiesserRoute(0);
  const firstBus = route.parts[1]!;
  const walking = route.parts[2]!;
  const secondBus = {
    from: { ...firstBus.to, plannedDeparture: "2026-08-09T14:53:00.000Z" },
    to: { ...firstBus.to, plannedDeparture: "2026-08-09T14:57:00.000Z" },
    line: { ...firstBus.line },
    intermediateStops: [],
  };
  route.parts = [
    route.parts[0]!,
    firstBus,
    secondBus,
    {
      ...walking,
      from: { ...firstBus.to, plannedDeparture: "2026-08-09T14:57:00.000Z" },
    },
  ];
  return route;
}

/** Sanitized mixed response: four feasible and one post-arrival alternative. */
export const RIESSER_MIXED_COORDINATE_ROUTES = [
  shiftedRiesserRoute(-37), // 16:22 +02:00 / 14:22Z
  shiftedRiesserRoute(-27), // 16:32 +02:00 / 14:32Z
  shiftedRiesserRoute(-16), // 16:43 +02:00 / 14:43Z
  shiftedRiesserRoute(-6), // 16:53 +02:00 / 14:53Z
  shiftedRiesserRoute(3), // 17:02 +02:00 / 15:02Z (late)
];

/** Sanitized mixed response: four feasible alternatives and one two-minute BUS→BUS overlap. */
export const RIESSER_BUS_OVERLAP_MIXED_COORDINATE_ROUTES = [
  shiftedRiesserRoute(-37),
  shiftedRiesserRoute(-27),
  shiftedRiesserRoute(-16),
  shiftedRiesserRoute(-6),
  twoMinuteBusOverlapRiesserRoute(),
];
