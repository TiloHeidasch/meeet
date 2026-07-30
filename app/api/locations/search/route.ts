import "server-only";

import {
  searchMvgLocations,
  validateLocationSearchQuery,
} from "../../../../lib/providers/mvg-locations.ts";

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  try {
    validateLocationSearchQuery(query);
  } catch {
    return Response.json(
      {
        error: {
          code: "INVALID_QUERY",
          message: "Enter a short location search query.",
        },
      },
      { status: 400 },
    );
  }

  try {
    return Response.json({
      locations: await searchMvgLocations(query, fetch, request.signal),
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "LOCATION_SEARCH_UNAVAILABLE",
          message: "Location search is temporarily unavailable.",
        },
      },
      { status: 503 },
    );
  }
}
