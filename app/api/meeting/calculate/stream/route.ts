import { handleMeetingStreamPost } from "../../../../../lib/domain/meeting-api.ts";
import { ProviderConfigurationError } from "../../../../../lib/providers/config.ts";
import { createMeetingProviders } from "../../../../../lib/providers/factory.ts";

export const maxDuration = 90;

export async function POST(request: Request): Promise<Response> {
  try {
    // The factory is deliberately deferred until handleMeetingStreamPost has
    // acquired the process-local slot. Artifact loading must not happen before
    // admission, and the stream must never start for invalid input or refused
    // admission.
    return await handleMeetingStreamPost(request, () => createMeetingProviders());
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      return Response.json(
        {
          error: {
            code: "PROVIDER_CONFIGURATION_INVALID",
            message: "Server provider configuration is invalid.",
          },
        },
        { status: 503 },
      );
    }
    throw error;
  }
}
