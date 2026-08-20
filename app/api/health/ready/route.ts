import "server-only";

import { connection } from "next/server";

import { loadScheduledArtifact } from "../../../../lib/domain/scheduled-routing/artifact.ts";
import { readProviderConfig } from "../../../../lib/providers/config.ts";
import { logError, logInfo } from "../../../../lib/log.ts";

export async function GET(): Promise<Response> {
  await connection();
  return readinessResponse();
}

export function readinessResponse(): Response {
  try {
    if (process.env.NODE_ENV !== "production") {
      logInfo("readiness: unavailable (not production)");
      return unavailable();
    }

    const config = readProviderConfig();
    if (config.mode !== "configured" || config.deployment !== "managed" || config.scheduledArtifactPath === null) {
      logInfo("readiness: unavailable (provider configuration not managed)");
      return unavailable();
    }

    const startedAt = Date.now();
    loadScheduledArtifact(config.scheduledArtifactPath);
    logInfo(`readiness: ready (artifact loaded in ${Date.now() - startedAt}ms)`);
    return new Response(null, { status: 204 });
  } catch (error) {
    logError(`readiness: unavailable (artifact load failed: ${error instanceof Error ? error.message : String(error)})`);
    return unavailable();
  }
}

function unavailable(): Response {
  return new Response(null, { status: 503 });
}
