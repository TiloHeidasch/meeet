import type { StationAreaMode } from "@/lib/client/meeting-response";

/** Intended display scale of each station icon in CSS pixels (bus = 100% baseline; sbahn 150%, ubahn 133%, tram ~116%). */
export const STATION_ICON_VISUAL_SIZES: Record<StationAreaMode, number> = { bus: 18, tram: 21, ubahn: 24, sbahn: 27 };

/** Spec ratios from issue #49: sbahn 150%, ubahn 133%, tram ~116%, bus 100% of the bus visual size. */
export const STATION_ICON_SPEC_RATIOS: Record<StationAreaMode, number> = { bus: 1, tram: 7 / 6, ubahn: 4 / 3, sbahn: 3 / 2 };

/** Padding around the station glyph visual size on each side, in CSS pixels. */
export const STATION_ICON_PADDING = 11;
