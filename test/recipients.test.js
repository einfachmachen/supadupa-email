import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRecipient,
  checkRecipientList,
  applySuggestions,
  deriveProfiles,
  sameName,
} from "../lib/recipients.js";

const PROFILES = [
  {
    id: "1",
    preferredName: "Max Mustermann",
    names: ["Mustermann, Max", "M. Mustermann"],
    emails: ["max@example.de", "max.mustermann@firma.de"],
  },
];

const codes = (r) => r.findings.map((f) => f.code);

test("korrekte Angabe wird durchgewinkt", () => {
  const r = checkRecipient({ name: "Max Mustermann", email: "max@example.de" }, PROFILES);
  assert.ok(r.ok);
  assert.deepEqual(codes(r), []);
});

test("fehlender Name wird erkannt und ergänzt", () => {
  const r = checkRecipient({ name: "", email: "max@example.de" }, PROFILES);
  assert.ok(codes(r).includes("no-name"));
  assert.deepEqual(r.suggestion, { name: "Max Mustermann", email: "max@example.de" });
});

test("falscher Name zur Adresse ist ein Fehler mit Korrektur", () => {
  const r = checkRecipient({ name: "Eva Beispiel", email: "max@example.de" }, PROFILES);
  assert.ok(codes(r).includes("name-mismatch"));
  assert.equal(r.suggestion.name, "Max Mustermann");
});

test("bekannte Schreibvariante ist kein Fehler, nur ein Hinweis", () => {
  const r = checkRecipient({ name: "Mustermann, Max", email: "max@example.de" }, PROFILES);
  assert.ok(r.ok);
  assert.deepEqual(codes(r), ["name-variant"]);
  assert.equal(r.suggestion.name, "Max Mustermann");
});

test("Adresse als Name getarnt", () => {
  const r = checkRecipient({ name: "max", email: "max@example.de" }, PROFILES);
  assert.ok(codes(r).includes("name-is-email"));
  assert.equal(r.suggestion.name, "Max Mustermann");
});

test("fehlende Adresse — Nachschlagen über den Namen", () => {
  const r = checkRecipient({ name: "M. Mustermann", email: "" }, PROFILES);
  assert.ok(codes(r).includes("no-email"));
  assert.equal(r.suggestion.email, "max@example.de");
});

test("Tippfehler-Domain wird vorgeschlagen", () => {
  const r = checkRecipient({ name: "Max Mustermann", email: "max@gmial.com" }, PROFILES);
  assert.ok(codes(r).includes("typo-domain"));
  assert.equal(r.suggestion.email, "max@gmail.com");
});

test("ungültige Adresse", () => {
  const r = checkRecipient({ name: "Max", email: "max@example" }, PROFILES);
  assert.ok(codes(r).includes("bad-email"));
  assert.ok(!r.ok);
});

test("Liste: leerer To-Header", () => {
  const res = checkRecipientList("", PROFILES);
  assert.ok(res.empty);
  assert.ok(!res.ok);
});

test("applySuggestions repariert einen ganzen Header", () => {
  const fixed = applySuggestions("max@example.de, Eva Beispiel <max.mustermann@firma.de>", PROFILES);
  assert.equal(fixed, "Max Mustermann <max@example.de>, Max Mustermann <max.mustermann@firma.de>");
});

test("Namensvergleich ist reihenfolge- und satzzeichenblind", () => {
  assert.ok(sameName("Mustermann, Max", "Max Mustermann"));
  assert.ok(sameName("max mustermann", "Max  Mustermann"));
  assert.ok(!sameName("Max Mustermann", "Eva Mustermann"));
  assert.ok(!sameName("", "Max"));
});

test("deriveProfiles nimmt den häufigsten Namen je Adresse", () => {
  const p = deriveProfiles([
    { name: "Max Mustermann", email: "Max@Example.de" },
    { name: "Max Mustermann", email: "max@example.de" },
    { name: "M. M.", email: "max@example.de" },
  ]);
  assert.equal(p.length, 1);
  assert.equal(p[0].preferredName, "Max Mustermann");
  assert.deepEqual(p[0].names, ["M. M."]);
});
