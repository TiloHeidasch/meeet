// Client-safe entrypoint: this module intentionally imports no server-only
// provider, filesystem, environment, or network code.
export {
  assertMeetingCalculationResponse,
  parseMeetingCalculationResponse,
  validateMeetingCalculationResponse,
} from "../domain/response.ts";
export type {
  FairLocation,
  PlannedParticipantJourney,
  RoutePattern,
  RoutePatternProvenance,
  MeetingSourceQueryProvenance,
  MeetingCalculationOkResponse,
  MeetingCalculationNoResultResponse,
  MeetingCalculationResponse,
  MeetingSearchCoverage,
  MeetingPatternSearchCoverage,
} from "../domain/types.ts";
