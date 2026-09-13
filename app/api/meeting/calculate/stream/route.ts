import {
  handleMeetingStreamPost,
  providerConfigurationErrorResponse,
  type ScheduledCalculationAdmissionLike,
} from "../../../../../lib/domain/meeting-api.ts";
import { ProviderConfigurationError } from "../../../../../lib/providers/config.ts";
import { createMeetingProviders } from "../../../../../lib/providers/factory.ts";
import type { MeetingProviders } from "../../../../../lib/domain/providers.ts";

export const maxDuration = 90;

export interface MeetingStreamRouteDependencies {
  readonly createProviders?: () => MeetingProviders;
  readonly admission?: ScheduledCalculationAdmissionLike;
}

export function createMeetingStreamPost(
  dependencies: MeetingStreamRouteDependencies = {},
): (request: Request) => Promise<Response> {
  const providersSource = dependencies.createProviders ?? (() => createMeetingProviders());
  const options = dependencies.admission === undefined ? {} : { admission: dependencies.admission };
  return async function POST(request: Request): Promise<Response> {
    try {
      // The factory is deliberately deferred until handleMeetingStreamPost has
      // acquired the process-local slot. Artifact loading must not happen before
      // admission, and the stream must never start for invalid input or refused
      // admission.
      return await handleMeetingStreamPost(request, providersSource, options);
    } catch (error) {
      if (error instanceof ProviderConfigurationError) return providerConfigurationErrorResponse();
      throw error;
    }
  };
}

export const POST = createMeetingStreamPost();
