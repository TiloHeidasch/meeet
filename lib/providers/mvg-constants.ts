import "server-only";

export const MVG_API_ORIGIN = "https://www.mvg.de";
export const MVG_API_BASE_URL = `${MVG_API_ORIGIN}/api/bgw-pt/v3`;
export const MVG_NEARBY_URL = `${MVG_API_BASE_URL}/stations/nearby`;
export const MVG_LOCATIONS_URL = `${MVG_API_BASE_URL}/locations`;

/** Validated search and nearby-station DTOs request one-day revalidation. */
export const MVG_UPSTREAM_REVALIDATE_SECONDS = 24 * 60 * 60;

/** Three decimal degrees give a conservative roughly 50–150 m Munich bucket. */
export const MVG_NEARBY_CACHE_DECIMAL_PLACES = 3;
