import { handleRouteFirstMeetingSubmit } from "../../../../lib/domain/route-first/api.ts";

export async function POST(request: Request): Promise<Response> {
  return handleRouteFirstMeetingSubmit(request);
}
