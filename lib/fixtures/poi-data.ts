import type { MeetingPointOfInterest } from "../domain/types.ts";

/**
 * Deliberately small, static Phase 1 demo-entry set. These are not live
 * listings and are not a claim of current availability or opening hours.
 */
export const FIXTURE_POIS: readonly MeetingPointOfInterest[] = [
  {
    id: "fixture-viktualienmarkt",
    name: "Viktualienmarkt",
    category: "food",
    coordinates: [11.5753, 48.1351],
    address: "Viktualienmarkt, München",
    source: "demo-static-poi-entry-v2",
  },
  {
    id: "fixture-cafe-frischhut",
    name: "Café Frischhut",
    category: "food",
    coordinates: [11.5734, 48.1343],
    address: "Prälat-Zistl-Straße 8, München",
    source: "demo-static-poi-entry-v2",
  },
  {
    id: "fixture-augustiner-keller",
    name: "Augustiner-Keller",
    category: "drink",
    coordinates: [11.5497, 48.1435],
    address: "Arnulfstraße 52, München",
    source: "demo-static-poi-entry-v2",
  },
  {
    id: "fixture-glockenspiel-cafe",
    name: "Glockenspiel Café",
    category: "drink",
    coordinates: [11.5758, 48.1371],
    address: "Marienplatz 28, München",
    source: "demo-static-poi-entry-v2",
  },
  {
    id: "fixture-ganswoerth",
    name: "Gans Woerth",
    category: "food",
    coordinates: [11.5844, 48.1323],
    address: "Gärtnerplatz, München",
    source: "demo-static-poi-entry-v2",
  },
];
