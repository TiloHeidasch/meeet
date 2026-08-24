import {
  handleStationAreaDetailsPost,
  providerConfigurationErrorResponse,
  type HandleMeetingPostOptions,
  type ScheduledCalculationAdmissionLike,
} from "../../../../../../lib/domain/meeting-api.ts";
import { ProviderConfigurationError } from "../../../../../../lib/providers/config.ts";
import { createMeetingProviders } from "../../../../../../lib/providers/factory.ts";
import type { MeetingProviders } from "../../../../../../lib/domain/providers.ts";
import type { StationAreaCalculationBasisCache } from "../../../../../../lib/domain/station-area-details-cache.ts";

export const maxDuration = 90;

export interface StationAreaDetailsRouteDependencies {
  readonly createProviders?: () => MeetingProviders;
  readonly admission?: ScheduledCalculationAdmissionLike;
  readonly basisCache?: StationAreaCalculationBasisCache;
}

export function createStationAreaDetailsPost(
  dependencies: StationAreaDetailsRouteDependencies = {},
): (
  request: Request,
  context: { params: Promise<{ stationAreaId: string }> },
) => Promise<Response> {
  const providersSource = dependencies.createProviders ?? (() => createMeetingProviders());
  const options: HandleMeetingPostOptions = {
    ...(dependencies.admission === undefined ? {} : { admission: dependencies.admission }),
    ...(dependencies.basisCache === undefined ? {} : { basisCache: dependencies.basisCache }),
  };
  return async function POST(
    request: Request,
    context: { params: Promise<{ stationAreaId: string }> },
  ): Promise<Response> {
    try {
      const { stationAreaId } = await context.params;
      return await handleStationAreaDetailsPost(request, stationAreaId, providersSource, options);
    } catch (error) {
      if (error instanceof ProviderConfigurationError) return providerConfigurationErrorResponse();
      throw error;
    }
  };
}

export const POST = createStationAreaDetailsPost();
