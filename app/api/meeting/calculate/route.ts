import { handleMeetingPost, ScheduledCalculationAdmission } from "../../../../lib/domain/meeting-api.ts";
import { ProviderConfigurationError, readProviderConfig } from "../../../../lib/providers/config.ts";
import { createMeetingProviders } from "../../../../lib/providers/factory.ts";

export const maxDuration = 90;
let scheduledAdmission: ScheduledCalculationAdmission | undefined;

export async function POST(request: Request): Promise<Response> {
  try {
    const config = readProviderConfig();
    const providers = createMeetingProviders();
    scheduledAdmission ??= new ScheduledCalculationAdmission(providers.scheduledConcurrency ?? config.scheduledConcurrency);
    return handleMeetingPost(request, providers, { deadlineMs: providers.scheduledDeadlineMs ?? config.scheduledDeadlineMs, admission: scheduledAdmission });
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
