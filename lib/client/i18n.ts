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
    scopePill: "Munich · MVV scheduled search",
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
    noResultEyebrow: "No meeting surface yet",
    resultEyebrow: "Surface ready",
    noResultHeading: "No scheduled route reached the surface.",
    resultHeading: "A fair place to meeet.",
    noResultAccessSeeds: "No nearby MVG access seed could be resolved for one or both origins, so the scheduled surface cannot be calculated.",
    noResultNoStations: "The MVV schedule could not reach a station from one or both origins during the planned search window.",
    resultBody: "Compare every eligible station area, then open the planned legs for either participant.",
    footer: "Scheduled MVV surface • Munich only • Built for two origins",
    inputsChanged: "Your inputs changed. Run the meeting search again.",
    cancelled: "Calculation cancelled. Your inputs are preserved.",
    refNotRetained: "Scheduled evidence is unavailable because the calculation reference was not retained safely.",
    detailsUnavailable: "The station-area details are unavailable right now.",
    detailsLoadFailed: "The station-area details could not be loaded.",
    chooseStartingPoint: "Choose a Munich starting point.",
    chooseBoth: "Choose both starting points before searching.",
    startingCalculation: "Starting the planned MVV calculation…",
    serviceUnavailable: "The MVG meeting service is unavailable right now.",
    surfaceVerificationFailed: "The meeting surface could not be verified. Please try again.",
    streamVerificationFailed: "The calculation stream could not be verified. Please try again.",
    searchEndedWithoutResult: "The meeting search ended without a result. Please try again.",
    searchFailed: "The meeting search could not be completed.",
    participantLabel: (number: number) => `Participant ${number}`,
  },
  phases: {
    accessSeeds: "Finding nearby transit access",
    scheduledRouting: "Checking planned MVV journeys",
    stationAreaEvaluation: "Comparing station areas",
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
  classification: {
    label: {
      red: "Red is quicker",
      blue: "Blue is quicker",
      fair: "Fair territory within tolerance",
      unclassified: "Unclassified",
    },
    short: {
      red: "Red territory",
      blue: "Blue territory",
      fair: "Fair · within tolerance",
      unclassified: "Unclassified · no fill",
    },
  },
  location: {
    participantOrigin: (number: number) => `Participant ${number} origin`,
    participant: (number: number) => `Participant ${number}`,
    transit: "Transit",
    startingPointLabel: "Starting point in Munich",
    startingPointAria: (number: number) => `Participant ${number} starting point`,
    placeholder: "Search a street, station, or place",
    searching: "Looking within Munich…",
  },
  legend: {
    ariaLabel: "Station-area territory legend",
    red: "Red is quicker",
    blue: "Blue is quicker",
    fair: "Fair territory within tolerance",
    unclassified: "Gray markers are unclassified station areas; unclassified territories are unfilled",
  },
  disclosure: {
    summary: "About this meeting surface",
    scopeTitle: "Munich / MVV scope.",
    scope: "This search uses the installed scheduled MVV feed for Munich and nearby MVG access data. It is not a venue recommendation.",
    plannedStart: "Planned start:",
    tolerance: "Tolerance:",
    schedule: "Schedule:",
    validRange: (firstDate: string, lastDate: string) => `valid ${firstDate} to ${lastDate}`,
    territories: "The map groups calculated station areas into translucent territories. Unclassified territories are intentionally unfilled; gray markers identify unclassified station areas. The planned route calculation is evaluated separately using the disclosed scheduled-routing method; the final station segment uses a geometric walking estimate, not walking directions or navigation.",
    source: "Source:",
    retrieved: "retrieved",
  },
  unavailable: {
    noAccessSeeds: "No nearby access seed was available for this participant, so no planned MVV route can be shown.",
    noReachableStations: "The scheduled MVV search could not reach a station for this participant.",
    stationAreaUnclassified: "This station area is unclassified, so scheduled evidence is unavailable for this participant.",
    stationAreaUnavailableForParticipant: "This station area has no scheduled evidence for this participant.",
    default: "Scheduled evidence is unavailable for this participant.",
  },
  provenance: {
    summary: "Schedule and access provenance",
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
    heading: "Calculated station areas",
    instructions: "Select an area to inspect its scheduled comparison. Every gray station area is included.",
    participant: (number: number) => `Participant ${number}`,
    noResult: "Scheduled evidence is unavailable for this result. These station areas remain shown for transparency.",
  },
  detailPanel: {
    selectPrompt: "Select a station area to inspect its scheduled comparison.",
    thisStationArea: "This station area",
    expired: "The saved calculation reference has expired, so station-area details can no longer be verified for the markers shown. Recalculate the meeting surface to inspect details again.",
    recalculate: "Recalculate meeting surface",
    noResult: "Scheduled evidence is unavailable for this result.",
    loading: (name: string) => `Loading scheduled details for ${name}…`,
    tolerance: (percent: number) => `tolerance ±${percent}%`,
    classificationExplanation: (percent: number) => `This classification compares the two participants' planned totals at the selected ±${percent}% tolerance.`,
    participant: (number: number) => `Participant ${number}`,
    total: "total",
    arriveAt: "Arrive at",
    heading: "Station-area details",
  },
  map: {
    originAria: (label: string) => `${label} origin.`,
    ariaOk: (count: number) => `Munich meeting territory map with ${count} calculated station-area markers; unclassified territories are unfilled and gray markers are unclassified station areas`,
    ariaNoResult: (count: number) => `Munich meeting territory map with ${count} unclassified station-area markers; unclassified territories are unfilled and gray markers are unclassified station areas`,
    ariaInitial: "Munich meeting map with two participant origins; unclassified territories are unfilled and gray markers are unclassified station areas",
    heading: "Munich meeting map",
    loading: "Loading Munich map…",
    unavailableTitle: "Map unavailable",
    unavailableBody: "The station-area territory map is unavailable; unclassified territories are unfilled. The planned route calculation is still separate.",
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
    scopePill: "München · MVV-Fahrplansuche",
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
    noResultEyebrow: "Noch keine Meeting-Fläche",
    resultEyebrow: "Fläche bereit",
    noResultHeading: "Keine geplante Route erreichte die Fläche.",
    resultHeading: "Ein fairer Ort zum Meeet.",
    noResultAccessSeeds: "Für einen oder beide Startpunkte konnte kein nahegelegener MVG-Zugangspunkt aufgelöst werden, daher kann die geplante Fläche nicht berechnet werden.",
    noResultNoStations: "Der MVV-Fahrplan konnte während des geplanten Suchzeitraums von einem oder beiden Startpunkten keine Haltestelle erreichen.",
    resultBody: "Vergleiche jeden geeigneten Stationsbereich und öffne dann die geplanten Wege für einen der Teilnehmer.",
    footer: "Geplante MVV-Fläche • Nur München • Für zwei Startpunkte",
    inputsChanged: "Deine Eingaben haben sich geändert. Führe die Meeting-Suche erneut aus.",
    cancelled: "Berechnung abgebrochen. Deine Eingaben bleiben erhalten.",
    refNotRetained: "Für diesen Stationsbereich sind keine Fahrplandaten verfügbar, weil die Berechnungsreferenz nicht sicher aufbewahrt wurde.",
    detailsUnavailable: "Die Stationsbereichsdetails sind derzeit nicht verfügbar.",
    detailsLoadFailed: "Die Stationsbereichsdetails konnten nicht geladen werden.",
    chooseStartingPoint: "Wähle einen Startpunkt in München.",
    chooseBoth: "Wähle beide Startpunkte, bevor du suchst.",
    startingCalculation: "Die geplante MVV-Berechnung wird gestartet…",
    serviceUnavailable: "Der MVG-Meeting-Dienst ist derzeit nicht verfügbar.",
    surfaceVerificationFailed: "Die Meeting-Fläche konnte nicht verifiziert werden. Bitte versuche es erneut.",
    streamVerificationFailed: "Der Berechnungsstream konnte nicht verifiziert werden. Bitte versuche es erneut.",
    searchEndedWithoutResult: "Die Meeting-Suche endete ohne Ergebnis. Bitte versuche es erneut.",
    searchFailed: "Die Meeting-Suche konnte nicht abgeschlossen werden.",
    participantLabel: (number: number) => `Teilnehmer ${number}`,
  },
  phases: {
    accessSeeds: "Nahegelegene ÖPNV-Zugänge werden gesucht",
    scheduledRouting: "Geplante MVV-Verbindungen werden geprüft",
    stationAreaEvaluation: "Stationsbereiche werden verglichen",
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
  classification: {
    label: {
      red: "Rot ist schneller",
      blue: "Blau ist schneller",
      fair: "Fairer Bereich innerhalb der Toleranz",
      unclassified: "Nicht klassifiziert",
    },
    short: {
      red: "Rotes Gebiet",
      blue: "Blaues Gebiet",
      fair: "Fair · innerhalb der Toleranz",
      unclassified: "Nicht klassifiziert · ohne Füllung",
    },
  },
  location: {
    participantOrigin: (number: number) => `Startpunkt von Teilnehmer ${number}`,
    participant: (number: number) => `Teilnehmer ${number}`,
    transit: "ÖPNV",
    startingPointLabel: "Startpunkt in München",
    startingPointAria: (number: number) => `Startpunkt von Teilnehmer ${number}`,
    placeholder: "Straße, Haltestelle oder Ort suchen",
    searching: "Suche in München…",
  },
  legend: {
    ariaLabel: "Legende der Stationsbereichs-Gebiete",
    red: "Rot ist schneller",
    blue: "Blau ist schneller",
    fair: "Fairer Bereich innerhalb der Toleranz",
    unclassified: "Graue Marker sind nicht klassifizierte Stationsbereiche; nicht klassifizierte Gebiete bleiben ungefüllt",
  },
  disclosure: {
    summary: "Über diese Meeting-Fläche",
    scopeTitle: "Geltungsbereich München / MVV.",
    scope: "Diese Suche verwendet den installierten geplanten MVV-Fahrplan für München und nahegelegene MVG-Zugangsdaten. Sie ist keine Empfehlung für einen Veranstaltungsort.",
    plannedStart: "Geplanter Start:",
    tolerance: "Toleranz:",
    schedule: "Fahrplan:",
    validRange: (firstDate: string, lastDate: string) => `gültig ${firstDate} bis ${lastDate}`,
    territories: "Die Karte fasst berechnete Stationsbereiche zu durchscheinenden Gebieten zusammen. Nicht klassifizierte Gebiete bleiben bewusst ungefüllt; graue Marker kennzeichnen nicht klassifizierte Stationsbereiche. Die geplante Routenberechnung wird separat mit der offengelegten Fahrplan-Routingmethode ausgewertet; das letzte Stationssegment verwendet eine geometrische Gehschätzung, keine Geh-Routen oder Navigation.",
    source: "Quelle:",
    retrieved: "abgerufen",
  },
  unavailable: {
    noAccessSeeds: "Für diesen Teilnehmer war kein nahegelegener Zugangspunkt verfügbar, daher kann keine geplante MVV-Route angezeigt werden.",
    noReachableStations: "Die geplante MVV-Suche konnte für diesen Teilnehmer keine Haltestelle erreichen.",
    stationAreaUnclassified: "Dieser Stationsbereich ist nicht klassifiziert, daher sind keine Fahrplandaten für diesen Teilnehmer verfügbar.",
    stationAreaUnavailableForParticipant: "Für diesen Stationsbereich liegen keine Fahrplandaten für diesen Teilnehmer vor.",
    default: "Für diesen Teilnehmer sind keine Fahrplandaten verfügbar.",
  },
  provenance: {
    summary: "Fahrplan- und Zugangsdaten-Herkunft",
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
    heading: "Berechnete Stationsbereiche",
    instructions: "Wähle einen Bereich aus, um seinen Fahrplanvergleich zu prüfen. Jeder graue Stationsbereich ist enthalten.",
    participant: (number: number) => `Teilnehmer ${number}`,
    noResult: "Für dieses Ergebnis sind keine Fahrplandaten verfügbar. Diese Stationsbereiche werden aus Transparenzgründen weiterhin angezeigt.",
  },
  detailPanel: {
    selectPrompt: "Wähle einen Stationsbereich aus, um seinen Fahrplanvergleich zu prüfen.",
    thisStationArea: "Dieser Stationsbereich",
    expired: "Die gespeicherte Berechnungsreferenz ist abgelaufen, daher können die Stationsbereichsdetails für die angezeigten Marker nicht mehr verifiziert werden. Berechne die Meeting-Fläche neu, um die Details erneut zu prüfen.",
    recalculate: "Meeting-Fläche neu berechnen",
    noResult: "Für dieses Ergebnis sind keine Fahrplandaten verfügbar.",
    loading: (name: string) => `Fahrplandetails für ${name} werden geladen…`,
    tolerance: (percent: number) => `Toleranz ±${percent}%`,
    classificationExplanation: (percent: number) => `Diese Klassifizierung vergleicht die geplanten Gesamtzeiten der beiden Teilnehmer bei der gewählten Toleranz von ±${percent}%.`,
    participant: (number: number) => `Teilnehmer ${number}`,
    total: "gesamt",
    arriveAt: "Ankunft um",
    heading: "Stationsbereichsdetails",
  },
  map: {
    originAria: (label: string) => `Startpunkt ${label}.`,
    ariaOk: (count: number) => `Meeting-Gebietskarte München mit ${count} berechneten Stationsbereichs-Markern; nicht klassifizierte Gebiete bleiben ungefüllt und graue Marker sind nicht klassifizierte Stationsbereiche`,
    ariaNoResult: (count: number) => `Meeting-Gebietskarte München mit ${count} nicht klassifizierten Stationsbereichs-Markern; nicht klassifizierte Gebiete bleiben ungefüllt und graue Marker sind nicht klassifizierte Stationsbereiche`,
    ariaInitial: "Meeting-Karte München mit zwei Startpunkten; nicht klassifizierte Gebiete bleiben ungefüllt und graue Marker sind nicht klassifizierte Stationsbereiche",
    heading: "Meeting-Karte München",
    loading: "München-Karte wird geladen…",
    unavailableTitle: "Karte nicht verfügbar",
    unavailableBody: "Die Gebietskarte der Stationsbereiche ist nicht verfügbar; nicht klassifizierte Gebiete bleiben ungefüllt. Die geplante Routenberechnung bleibt davon getrennt.",
  },
};

export const messages = { en, de } as const;