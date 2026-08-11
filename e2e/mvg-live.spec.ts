import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

test("calculates against the live MVG direct-transit provider", async ({ request }) => {
  const payload = {
    participants: [
      {
        id: "participant-1",
        mode: "transit",
        location: {
          label: "Reichenbachstraße 1",
          latitude: 48.134265500000005,
          longitude: 11.5765195,
        },
      },
      {
        id: "participant-2",
        mode: "transit",
        location: {
          label: "Rotkreuzplatz",
          latitude: 48.153423,
          longitude: 11.53312,
        },
      },
    ],
    arrivalAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    tolerancePercent: 10,
  } as const;

  const response = await request.post("/api/meeting/calculate", { data: payload });

  expect(response.status()).not.toBe(503);
  expect(response.ok()).toBe(true);

  const body = (await response.json()) as {
    contractVersion: string;
    status: "ok" | "no-result";
    reason?: string;
    fairLocations: readonly unknown[];
    metadata: {
      routing: {
        provider: string;
        deployment: string;
        dataKind: string;
        liveData: boolean;
        provenance: {
          provider: string;
          sourceUrl: string | null;
          liveData: boolean;
        };
      };
    };
  };

  expect(body.contractVersion).toBe("meeet-meeting/v2");
  expect(["ok", "no-result"]).toContain(body.status);
  if (body.status === "no-result") {
    expect(body.reason).toBe("no-transit-station-targets");
    expect(body.fairLocations).toEqual([]);
  }

  expect(body.metadata.routing).toMatchObject({
    name: "mvg-direct-routing",
    dataKind: "scheduled",
    liveData: false,
  });
  expect(body.metadata.routing.deployment).not.toBe("fixture");
  expect(body.metadata.routing.provenance).toMatchObject({
    provider: "mvg-direct-routing",
    sourceUrl: "https://www.mvg.de/api/bgw-pt/v3",
    liveData: false,
  });
});
