// Client-safe entrypoint: this module intentionally imports no server-only
// provider, filesystem, environment, or network code.
export {
  assertMeetingCalculationResponse,
  parseMeetingCalculationResponse,
  validateMeetingCalculationResponse,
} from "../domain/response.ts";
export type {
  MeetingCalculationNoCorridorResponse,
  MeetingCalculationOkResponse,
  MeetingCalculationResponse,
} from "../domain/types.ts";
