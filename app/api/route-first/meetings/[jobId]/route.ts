import { handleRouteFirstMeetingStatus } from "../../../../../lib/domain/route-first/api.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await context.params;
  return handleRouteFirstMeetingStatus(request, jobId);
}
