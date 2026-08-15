import "server-only";

import { connection } from "next/server";

import { loadScheduledArtifact } from "../../../../lib/domain/scheduled-routing/artifact.ts";
import { readProviderConfig } from "../../../../lib/providers/config.ts";

export async function GET(_request: Request): Promise<Response> {
  await connection();
  return readinessResponse();
}

export function readinessResponse(): Response {
  try {
    if (process.env.NODE_ENV !== "production") return unavailable();

    const config = readProviderConfig();
    if (config.mode !== "configured" || config.deployment !== "managed" || config.scheduledArtifactPath === null) {
      return unavailable();
    }

    loadScheduledArtifact(config.scheduledArtifactPath);
    return new Response(null, { status: 204 });
  } catch {
    return unavailable();
  }
}

function unavailable(): Response {
  return new Response(null, { status: 503 });
}
