import { handleStationAreaDetailsPost } from "../../../../../../lib/domain/meeting-api.ts";
import { ProviderConfigurationError } from "../../../../../../lib/providers/config.ts";
import { createMeetingProviders } from "../../../../../../lib/providers/factory.ts";

export const maxDuration = 90;

export async function POST(
  request: Request,
  context: { params: Promise<{ stationAreaId: string }> },
): Promise<Response> {
  try {
    const { stationAreaId } = await context.params;
    return await handleStationAreaDetailsPost(request, stationAreaId, () => createMeetingProviders());
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
