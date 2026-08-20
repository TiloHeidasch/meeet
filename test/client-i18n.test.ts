import assert from "node:assert/strict";
import test from "node:test";

import { messages, resolveLocale, resolveLocaleFromHeader } from "../lib/client/i18n.ts";

test("resolveLocale matches German before falling back to English", () => {
  assert.equal(resolveLocale(["de"]), "de");
  assert.equal(resolveLocale(["de-DE"]), "de");
  assert.equal(resolveLocale(["de-AT", "en-US"]), "de");
  assert.equal(resolveLocale(["DE"]), "de");
  assert.equal(resolveLocale(["en-US", "de"]), "de");
  assert.equal(resolveLocale(["en-US"]), "en");
  assert.equal(resolveLocale(["fr-FR"]), "en");
  assert.equal(resolveLocale(["es"]), "en");
  assert.equal(resolveLocale([]), "en");
  assert.equal(resolveLocale(["en-GB", "fr"]), "en");
});

test("resolveLocaleFromHeader parses Accept-Language headers", () => {
  assert.equal(resolveLocaleFromHeader("de-DE,de;q=0.9,en;q=0.8"), "de");
  assert.equal(resolveLocaleFromHeader("de"), "de");
  assert.equal(resolveLocaleFromHeader("en-US,en;q=0.9"), "en");
  assert.equal(resolveLocaleFromHeader("fr-FR"), "en");
  assert.equal(resolveLocaleFromHeader(null), "en");
  assert.equal(resolveLocaleFromHeader(""), "en");
});

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

test("de dictionary has exactly the same key structure as en", () => {
  assert.deepEqual([...keyPaths(messages.de)].sort(), [...keyPaths(messages.en)].sort());
});

test("time formatting matches the expected English and German output", () => {
  assert.equal(messages.en.time.formatSeconds(1800), "30 min");
  assert.equal(messages.en.time.formatSeconds(1830), "30 min 30 sec");
  assert.equal(messages.de.time.formatSeconds(1830), "30 Min. 30 Sek.");
});

test("participant labels are localized", () => {
  assert.equal(messages.en.planner.participantLabel(1), "Participant 1");
  assert.equal(messages.de.planner.participantLabel(1), "Teilnehmer 1");
});

test("map aria labels include the station-area marker count", () => {
  assert.ok(messages.en.map.ariaOk(4).includes("4 calculated station-area markers"));
});