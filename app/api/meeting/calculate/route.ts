import { handleMeetingPost } from "../../../../lib/domain/meeting-api.ts";
import { ProviderConfigurationError } from "../../../../lib/providers/config.ts";
import { createMeetingProviders } from "../../../../lib/providers/factory.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return handleMeetingPost(request, createMeetingProviders());
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
