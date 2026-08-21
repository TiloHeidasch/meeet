// Client-side localization for the meeet UI.
//
// Locale resolution uses the browser's language preferences
// (`navigator.languages`), matching German (`de`, `de-DE`, …) before falling
// back to English for every other locale. There is no in-app language
// switcher: browser settings are the only signal.
//
// The module is importable from server components too: `resolveLocale` and
// `resolveLocaleFromHeader` are pure, and `useLocale` only touches
// `navigator` inside its client snapshot getter.

import * as React from "react";

export type Locale = "de" | "en";

/**
 * Matches German (`de`, `de-DE`, `de-AT`, …) before falling back to English.
 * Order-insensitive by design: any German preference wins, even a secondary
 * one (product criterion: German from browser settings, English fallback).
 */
export function resolveLocale(languages: readonly string[]): Locale {
  return languages.some((language) => language.trim().toLowerCase().startsWith("de")) ? "de" : "en";
}

/** Resolves the locale from an `Accept-Language` header value (server shell). */
export function resolveLocaleFromHeader(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return "en";
  return resolveLocale(acceptLanguage.split(",").map((part) => part.split(";")[0]!.trim()));
}

const subscribe = () => () => {};

/** Reads the browser language preferences; SSR-safe with an English snapshot. */
export function useLocale(): Locale {
  return React.useSyncExternalStore(
    subscribe,
    () => resolveLocale(navigator.languages),
    () => "en",
  );
}

const en = {
  shell: {
    metadataTitle: "meeet — find a fair meeting point",
    metadataDescription: "Compare local demonstration travel estimates for Munich meeting places.",
    loadingMap: "Preparing your meeting map…",
  },
  planner: {
    scopePill: "MVV area · Munich meeting surface",
    eyebrow: "A better place to meeet",
    headlinePart1: "Find the middle,",
    headlinePart2: "without guessing.",
    lede: "Two origins. One planned start. A map of where public transport gets you close enough.",
    searchUnavailable: "Meeting search unavailable",
    unavailableMessage: "The scheduled MVV service is not available for this installation.",
    plannedStart: "Planned start",
    startHint: "Now + 5 minutes · whole seconds",
    tolerance: "Travel-time tolerance",
    changeTime: "Change time",
    calculating: "Calculating…",
    cancel: "Cancel",
    retry: "Try again",
    progressAria: "Calculation progress",
    progressStarting: "Starting the planned calculation…",
    progressNote: "This is a planned MVV schedule calculation, not live transit information.",
    noResultEyebrow: "No result yet",
    resultEyebrow: "Meeting result",
    noResultHeading: "No meeting places could be calculated for these starting points.",
    resultHeading: (count: number) => count === 0 ? "No fair meeting places found" : count === 1 ? "1 fair meeting place found" : `${count} fair meeting places found`,
    noResultAccessSeeds: "A nearby public-transit stop could not be found for one or both starting points, so the two arrivals cannot be compared. Try different starting points.",
    noResultNoStations: "The scheduled MVV timetable could not reach a stop from one or both starting points during the planned search window. Try different starting points or a later planned start.",
    resultTolerance: (percent: number) => `With a ±${percent}% tolerance, two arrivals count as fair when they differ by no more than ${percent}% of the two journeys' combined duration.`,
    resultAction: (count: number): string => count > 0 ? "Select a fair meeting place to compare the two planned arrivals." : "Select a meeting place to compare the two planned arrivals.",
    footer: "Scheduled MVV surface • Munich meeting • MVV-area origins",
    inputsChanged: "Your inputs changed. Run the meeting search again.",
    cancelled: "Calculation cancelled. Your inputs are preserved.",
    refNotRetained: "The saved calculation is no longer available, so meeting-place details cannot be shown. Search again to compare places.",
    detailsUnavailable: "Meeting-place details are unavailable right now.",
    detailsLoadFailed: "Meeting-place details could not be loaded.",
    chooseStartingPoint: "Choose a starting point in the MVV area.",
    chooseBoth: "Choose both starting points before searching.",
    startingCalculation: "Starting the planned MVV calculation…",
    serviceUnavailable: "The meeting service is temporarily unavailable. Please try again shortly.",
    surfaceVerificationFailed: "The result could not be verified. Please try again.",
    streamVerificationFailed: "The calculation could not be verified. Please try again.",
    searchEndedWithoutResult: "The search ended without a result. Please try again.",
    searchFailed: "The meeting search could not be completed.",
    participantLabel: (number: number) => `Participant ${number}`,
  },
  phases: {
    accessSeeds: "Finding nearby transit access",
    scheduledRouting: "Checking planned MVV journeys",
    stationAreaEvaluation: "Comparing meeting places",
    validatingResult: "Preparing the validated map",
  },
  time: {
    noScheduledArrival: "No scheduled arrival",
    formatSeconds: (value: number) => `${Math.floor(value / 60)} min${value % 60 ? ` ${value % 60} sec` : ""}`,
    formatDate: (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
  },
  changeTime: {
    quick: "Quick",
    medium: "Medium",
    long: "Long",
    quickHint: "3 min",
    mediumHint: "5 min",
    longHint: "10 min",
  },
  contextStrip: {
    plannedStart: "Planned start",
    tolerance: "Tolerance",
    basis: "Schedule",
    basisValue: "Scheduled MVV timetable",
  },
  classification: {
    label: {
      red: "Participant 1 arrives sooner",
      blue: "Participant 2 arrives sooner",
      fair: "Both arrive within tolerance",
      unclassified: "No scheduled comparison available",
    },
    short: {
      red: "Participant 1 sooner",
      blue: "Participant 2 sooner",
      fair: "Fair · within tolerance",
      unclassified: "No comparison",
    },
  },
  location: {
    participantOrigin: (number: number) => `Participant ${number} origin`,
    participant: (number: number) => `Participant ${number}`,
    transit: "Transit",
    startingPointLabel: "Starting point in the MVV area",
    startingPointAria: (number: number) => `Participant ${number} starting point`,
    placeholder: "Search a street, station, or place",
    searching: "Looking in the MVV area…",
  },
  legend: {
    ariaLabel: "Meeting-place color legend",
    red: "Participant 1 arrives sooner",
    blue: "Participant 2 arrives sooner",
    fair: "Both arrive within tolerance",
    unclassified: "No scheduled comparison available",
  },
  disclosure: {
    summary: "How this result was calculated",
    scopeTitle: "MVV-area origins / Munich meeting surface.",
    scope: "This search uses the installed scheduled MVV feed for the MVV area and nearby MVG access data. Origins may be anywhere in the MVV area; the meeting surface is Munich-only. It is not a venue recommendation.",
    plannedStart: "Planned start:",
    tolerance: "Tolerance:",
    schedule: "Schedule:",
    validRange: (firstDate: string, lastDate: string) => `valid ${firstDate} to ${lastDate}`,
    territories: "The map groups calculated station areas into translucent territories. Unclassified territories are intentionally unfilled; gray markers identify unclassified station areas. The planned route calculation is evaluated separately using the disclosed scheduled-routing method; the final station segment uses a geometric walking estimate, not walking directions or navigation.",
    source: "Source:",
    retrieved: "retrieved",
  },
  unavailable: {
    noAccessSeeds: "No nearby transit access was available for this participant, so no planned route can be shown.",
    noReachableStations: "The scheduled MVV search could not reach a stop for this participant.",
    stationAreaUnclassified: "This meeting place has no scheduled comparison for either participant.",
    stationAreaUnavailableForParticipant: "This meeting place has no scheduled comparison for this participant.",
    default: "No scheduled comparison is available for this participant.",
  },
  provenance: {
    summary: "Method and data sources",
    scheduleHeading: "Scheduled MVV feed",
    feed: "Feed:",
    timezone: "Timezone:",
    valid: "Valid:",
    feedVersion: "Feed version:",
    retrieved: "Retrieved:",
    source: "Source:",
    officialAttribution: "Official attribution:",
    license: "License:",
    accessHeading: "Access data",
    provider: "Provider:",
    dataKind: "Data kind:",
    deployment: "Deployment:",
    asOf: "As of:",
    nonLive: "non-live access data",
    provenance: "Provenance:",
    version: "version",
    retrievedAt: "retrieved",
    attribution: "Attribution:",
  },
  stationList: {
    accessibleIndex: "Accessible map index",
    heading: "Meeting places",
    instructions: "Select a meeting place to compare the two planned arrivals. Places without a scheduled comparison are shown in gray.",
    participant: (number: number) => `Participant ${number}`,
    noResult: "No planned comparison is available for this result. These places remain shown for transparency.",
  },
  detailPanel: {
    selectPrompt: "Select a meeting place to compare the two planned arrivals.",
    thisStationArea: "This meeting place",
    expired: "The saved calculation has expired, so meeting-place details can no longer be verified. Recalculate meeting places to inspect details again.",
    recalculate: "Recalculate meeting places",
    noResult: "No planned comparison is available for this result.",
    loading: (name: string) => `Loading planned details for ${name}…`,
    tolerance: (percent: number) => `tolerance ±${percent}%`,
    classificationExplanation: (percent: number) => `This result compares the two participants' planned journeys at the selected ±${percent}% tolerance.`,
    participant: (number: number) => `Participant ${number}`,
    total: "total",
    arriveAt: "Arrive at",
    heading: "Meeting place details",
  },
  map: {
    originAria: (label: string) => `${label} origin.`,
    ariaOk: (count: number) => `Munich meeting map with ${count} meeting-place markers; red means Participant 1 arrives sooner, blue means Participant 2 arrives sooner, yellow means both arrive within tolerance, gray means no scheduled comparison is available`,
    ariaNoResult: (count: number) => `Munich meeting map with ${count} meeting-place markers; no scheduled comparison is available for these places`,
    ariaInitial: "Munich meeting map with two participant starting points",
    heading: "Munich meeting map",
    loading: "Loading Munich map…",
    refocus: "Refocus map",
    unavailableTitle: "Map unavailable",
    unavailableBody: "The map cannot be displayed right now. The meeting places below can still be selected and compared.",
  },
};

export type Messages = typeof en;

const de: Messages = {
  shell: {
    metadataTitle: "meeet — einen fairen Treffpunkt finden",
    metadataDescription: "Vergleiche lokale Fahrzeit-Schätzungen für Münchner Treffpunkte.",
    loadingMap: "Deine Meeting-Karte wird vorbereitet…",
  },
  planner: {
    scopePill: "MVV-Gebiet · Münchner Meeting-Fläche",
    eyebrow: "Ein besserer Ort zum Meeet",
    headlinePart1: "Finde die Mitte,",
    headlinePart2: "ohne zu raten.",
    lede: "Zwei Startpunkte. Ein geplanter Start. Eine Karte, die zeigt, wohin dich der öffentliche Nahverkehr rechtzeitig bringt.",
    searchUnavailable: "Meeting-Suche nicht verfügbar",
    unavailableMessage: "Der geplante MVV-Dienst ist für diese Installation nicht verfügbar.",
    plannedStart: "Geplanter Start",
    startHint: "Jetzt + 5 Minuten · ganze Sekunden",
    tolerance: "Fahrzeit-Toleranz",
    changeTime: "Umstiegszeit",
    calculating: "Berechnung läuft…",
    cancel: "Abbrechen",
    retry: "Erneut versuchen",
    progressAria: "Berechnungsfortschritt",
    progressStarting: "Die geplante Berechnung wird gestartet…",
    progressNote: "Dies ist eine geplante MVV-Fahrplanberechnung, keine Live-Verkehrsinformation.",
    noResultEyebrow: "Noch kein Ergebnis",
    resultEyebrow: "Dein Ergebnis",
    noResultHeading: "Für diese Startpunkte konnte kein Treffpunkt berechnet werden.",
    resultHeading: (count: number) => count === 0 ? "Keine fairen Treffpunkte gefunden" : count === 1 ? "1 fairer Treffpunkt gefunden" : `${count} faire Treffpunkte gefunden`,
    noResultAccessSeeds: "Für einen oder beide Startpunkte konnte kein nahegelegener ÖPNV-Halt gefunden werden, daher können die beiden Ankünfte nicht verglichen werden. Versuche andere Startpunkte.",
    noResultNoStations: "Der geplante MVV-Fahrplan konnte während des Suchzeitraums von einem oder beiden Startpunkten aus keinen Halt erreichen. Versuche andere Startpunkte oder einen späteren geplanten Start.",
    resultTolerance: (percent: number) => `Bei einer Toleranz von ±${percent}% gelten zwei Ankünfte als fair, wenn sie um höchstens ${percent}% der kombinierten Fahrzeit beider Fahrten voneinander abweichen.`,
    resultAction: (count: number): string => count > 0 ? "Wähle einen fairen Treffpunkt aus, um die beiden geplanten Ankünfte zu vergleichen." : "Wähle einen Treffpunkt aus, um die beiden geplanten Ankünfte zu vergleichen.",
    footer: "Geplante MVV-Fläche • Meeting in München • Startpunkte im MVV-Gebiet",
    inputsChanged: "Deine Eingaben haben sich geändert. Führe die Meeting-Suche erneut aus.",
    cancelled: "Berechnung abgebrochen. Deine Eingaben bleiben erhalten.",
    refNotRetained: "Die gespeicherte Berechnung ist nicht mehr verfügbar, daher können die Treffpunktdetails nicht angezeigt werden. Suche erneut, um Treffpunkte zu vergleichen.",
    detailsUnavailable: "Die Treffpunktdetails sind derzeit nicht verfügbar.",
    detailsLoadFailed: "Die Treffpunktdetails konnten nicht geladen werden.",
    chooseStartingPoint: "Wähle einen Startpunkt im MVV-Gebiet.",
    chooseBoth: "Wähle beide Startpunkte, bevor du suchst.",
    startingCalculation: "Die geplante MVV-Berechnung wird gestartet…",
    serviceUnavailable: "Der Meeting-Dienst ist derzeit nicht verfügbar. Bitte versuche es in Kürze erneut.",
    surfaceVerificationFailed: "Das Ergebnis konnte nicht verifiziert werden. Bitte versuche es erneut.",
    streamVerificationFailed: "Die Berechnung konnte nicht verifiziert werden. Bitte versuche es erneut.",
    searchEndedWithoutResult: "Die Suche endete ohne Ergebnis. Bitte versuche es erneut.",
    searchFailed: "Die Meeting-Suche konnte nicht abgeschlossen werden.",
    participantLabel: (number: number) => `Teilnehmer ${number}`,
  },
  phases: {
    accessSeeds: "Nahegelegene ÖPNV-Zugänge werden gesucht",
    scheduledRouting: "Geplante MVV-Verbindungen werden geprüft",
    stationAreaEvaluation: "Treffpunkte werden verglichen",
    validatingResult: "Die validierte Karte wird vorbereitet",
  },
  time: {
    noScheduledArrival: "Keine geplante Ankunft",
    formatSeconds: (value: number) => `${Math.floor(value / 60)} Min.${value % 60 ? ` ${value % 60} Sek.` : ""}`,
    formatDate: (iso: string) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
  },
  changeTime: {
    quick: "Kurz",
    medium: "Mittel",
    long: "Lang",
    quickHint: "3 Min.",
    mediumHint: "5 Min.",
    longHint: "10 Min.",
  },
  contextStrip: {
    plannedStart: "Geplanter Start",
    tolerance: "Toleranz",
    basis: "Fahrplan",
    basisValue: "Geplanter MVV-Fahrplan",
  },
  classification: {
    label: {
      red: "Teilnehmer 1 kommt früher an",
      blue: "Teilnehmer 2 kommt früher an",
      fair: "Beide kommen innerhalb der Toleranz an",
      unclassified: "Kein geplanter Vergleich verfügbar",
    },
    short: {
      red: "Teilnehmer 1 früher",
      blue: "Teilnehmer 2 früher",
      fair: "Fair · innerhalb der Toleranz",
      unclassified: "Kein Vergleich",
    },
  },
  location: {
    participantOrigin: (number: number) => `Startpunkt von Teilnehmer ${number}`,
    participant: (number: number) => `Teilnehmer ${number}`,
    transit: "ÖPNV",
    startingPointLabel: "Startpunkt im MVV-Gebiet",
    startingPointAria: (number: number) => `Startpunkt von Teilnehmer ${number}`,
    placeholder: "Straße, Haltestelle oder Ort suchen",
    searching: "Suche im MVV-Gebiet…",
  },
  legend: {
    ariaLabel: "Legende der Treffpunkt-Farben",
    red: "Teilnehmer 1 kommt früher an",
    blue: "Teilnehmer 2 kommt früher an",
    fair: "Beide kommen innerhalb der Toleranz an",
    unclassified: "Kein geplanter Vergleich verfügbar",
  },
  disclosure: {
    summary: "So wurde dieses Ergebnis berechnet",
    scopeTitle: "Startpunkte im MVV-Gebiet / Meeting-Fläche in München.",
    scope: "Diese Suche verwendet den installierten geplanten MVV-Fahrplan für das MVV-Gebiet und nahegelegene MVG-Zugangsdaten. Startpunkte können überall im MVV-Gebiet liegen; die Meeting-Fläche ist auf München beschränkt. Sie ist keine Empfehlung für einen Veranstaltungsort.",
    plannedStart: "Geplanter Start:",
    tolerance: "Toleranz:",
    schedule: "Fahrplan:",
    validRange: (firstDate: string, lastDate: string) => `gültig ${firstDate} bis ${lastDate}`,
    territories: "Die Karte fasst berechnete Stationsbereiche zu durchscheinenden Gebieten zusammen. Nicht klassifizierte Gebiete bleiben bewusst ungefüllt; graue Marker kennzeichnen nicht klassifizierte Stationsbereiche. Die geplante Routenberechnung wird separat mit der offengelegten Fahrplan-Routingmethode ausgewertet; das letzte Stationssegment verwendet eine geometrische Gehschätzung, keine Geh-Routen oder Navigation.",
    source: "Quelle:",
    retrieved: "abgerufen",
  },
  unavailable: {
    noAccessSeeds: "Für diesen Teilnehmer war kein nahegelegener ÖPNV-Zugang verfügbar, daher kann keine geplante Route angezeigt werden.",
    noReachableStations: "Die geplante MVV-Suche konnte für diesen Teilnehmer keinen Halt erreichen.",
    stationAreaUnclassified: "Dieser Treffpunkt hat für keinen der Teilnehmer einen geplanten Vergleich.",
    stationAreaUnavailableForParticipant: "Dieser Treffpunkt hat für diesen Teilnehmer keinen geplanten Vergleich.",
    default: "Für diesen Teilnehmer ist kein geplanter Vergleich verfügbar.",
  },
  provenance: {
    summary: "Methode und Datenquellen",
    scheduleHeading: "Geplanter MVV-Fahrplan",
    feed: "Feed:",
    timezone: "Zeitzone:",
    valid: "Gültig:",
    feedVersion: "Feed-Version:",
    retrieved: "Abgerufen:",
    source: "Quelle:",
    officialAttribution: "Offizielle Quellenangabe:",
    license: "Lizenz:",
    accessHeading: "Zugangsdaten",
    provider: "Anbieter:",
    dataKind: "Datentyp:",
    deployment: "Bereitstellung:",
    asOf: "Stand:",
    nonLive: "keine Live-Zugangsdaten",
    provenance: "Herkunft:",
    version: "Version",
    retrievedAt: "abgerufen",
    attribution: "Quellenangabe:",
  },
  stationList: {
    accessibleIndex: "Barrierefreier Kartenindex",
    heading: "Treffpunkte",
    instructions: "Wähle einen Treffpunkt aus, um die beiden geplanten Ankünfte zu vergleichen. Treffpunkte ohne geplanten Vergleich sind grau dargestellt.",
    participant: (number: number) => `Teilnehmer ${number}`,
    noResult: "Für dieses Ergebnis ist kein geplanter Vergleich verfügbar. Diese Treffpunkte werden aus Transparenzgründen weiterhin angezeigt.",
  },
  detailPanel: {
    selectPrompt: "Wähle einen Treffpunkt aus, um die beiden geplanten Ankünfte zu vergleichen.",
    thisStationArea: "Dieser Treffpunkt",
    expired: "Die gespeicherte Berechnung ist abgelaufen, daher können die Treffpunktdetails nicht mehr verifiziert werden. Berechne die Treffpunkte neu, um die Details erneut zu prüfen.",
    recalculate: "Treffpunkte neu berechnen",
    noResult: "Für dieses Ergebnis ist kein geplanter Vergleich verfügbar.",
    loading: (name: string) => `Geplante Details für ${name} werden geladen…`,
    tolerance: (percent: number) => `Toleranz ±${percent}%`,
    classificationExplanation: (percent: number) => `Dieses Ergebnis vergleicht die geplanten Fahrten der beiden Teilnehmer bei der gewählten Toleranz von ±${percent}%.`,
    participant: (number: number) => `Teilnehmer ${number}`,
    total: "gesamt",
    arriveAt: "Ankunft um",
    heading: "Treffpunktdetails",
  },
  map: {
    originAria: (label: string) => `Startpunkt ${label}.`,
    ariaOk: (count: number) => `Meeting-Karte München mit ${count} Treffpunkt-Markern; Rot bedeutet, Teilnehmer 1 kommt früher an, Blau bedeutet, Teilnehmer 2 kommt früher an, Gelb bedeutet, beide kommen innerhalb der Toleranz an, Grau bedeutet, kein geplanter Vergleich ist verfügbar`,
    ariaNoResult: (count: number) => `Meeting-Karte München mit ${count} Treffpunkt-Markern; für diese Treffpunkte ist kein geplanter Vergleich verfügbar`,
    ariaInitial: "Meeting-Karte München mit zwei Startpunkten",
    heading: "Meeting-Karte München",
    loading: "München-Karte wird geladen…",
    refocus: "Karte neu zentrieren",
    unavailableTitle: "Karte nicht verfügbar",
    unavailableBody: "Die Karte kann derzeit nicht angezeigt werden. Die Treffpunkte unten können weiterhin ausgewählt und verglichen werden.",
  },
};

export const messages = { en, de } as const;