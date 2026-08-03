import "server-only";

import { createHash } from "node:crypto";
import { canonicalClientSubmissionKey, type RouteFirstClientSubmission } from "./request-contract.ts";

/** Opaque request identity; never exposes caller origins or other submission fields. */
export function routeFirstClientSubmissionFingerprint(submission: RouteFirstClientSubmission): string {
  return createHash("sha256").update(canonicalClientSubmissionKey(submission)).digest("base64url");
}
