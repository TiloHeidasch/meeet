import type { StationAreaMode } from "@/lib/client/meeting-response";

/** Intended display scale of each station icon in CSS pixels (bus = 100% baseline; sbahn 200%, ubahn 166%, tram 133%). */
export const STATION_ICON_VISUAL_SIZES: Record<StationAreaMode, number> = { bus: 18, tram: 24, ubahn: 30, sbahn: 36 };

/** Spec ratios from issue #39: sbahn 200%, ubahn 166%, tram 133%, bus 100% of the bus visual size. */
export const STATION_ICON_SPEC_RATIOS: Record<StationAreaMode, number> = { bus: 1, tram: 4 / 3, ubahn: 5 / 3, sbahn: 2 };

/** Padding around the station glyph visual size on each side, in CSS pixels. */
export const STATION_ICON_PADDING = 11;
