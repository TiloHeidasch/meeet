// Single source of truth for the meeet brand-mark geometry.
//
// The pin-headed "M" mark is drawn on a 64×64 grid. Every icon touchpoint is
// derived from the two path strings below:
//
//   - components/MeetPlanner.tsx renders them inline in the header mark
//   - scripts/generate-brand-icons.ts writes app/icon.svg from them and
//     rasterizes the favicon/apple-touch-icon PNGs from the same geometry
//
// Change the mark here, run `npm run icons:brand`, and every format follows.

// Black pin-notch plate: a rounded square (corner radius 13) with a 45-degree
// pin notch cut into the bottom edge (tip at 32,46; feet at 20/44,58), so the
// silhouette reads as a map-pin head rather than a plain rounded rect.
export const BRAND_MARK_PLATE_D =
  "M 19 6 L 45 6 A 13 13 0 0 1 58 19 L 58 45 A 13 13 0 0 1 45 58 L 44 58 L 32 46 L 20 58 L 19 58 A 13 13 0 0 1 6 45 L 6 19 A 13 13 0 0 1 19 6 Z";

// Yellow bold geometric M: 8-unit stems at x 11..19 and 45..53, a wide counter
// V from y 12 (x 25..39) tapering to the apex at (32,40), which sits on the
// same vertical axis as the plate's notch tip. The wide counter keeps the M
// unambiguous at 16×16 favicon size.
export const BRAND_MARK_LETTER_D =
  "M 11 12 L 53 12 L 53 40 L 45 40 L 32 40 L 39 12 L 25 12 L 32 40 L 19 40 L 11 40 Z";
