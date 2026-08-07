import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeHeaderValue,
  encodeDisplayName,
  formatAddress,
  parseAddress,
  parseAddressList,
  splitAddressList,
  formatAddressList,
  isPlausibleEmail,
} from "../lib/mime.js";

test("dekodiert encoded-words (B und Q)", () => {
  assert.equal(decodeHeaderValue("=?UTF-8?B?TcO8bGxlcg==?="), "Müller");
  assert.equal(decodeHeaderValue("=?UTF-8?Q?M=C3=BCller?="), "Müller");
  assert.equal(decodeHeaderValue("=?UTF-8?Q?Max_Mustermann?="), "Max Mustermann");
});

test("verbindet angrenzende encoded-words ohne Leerzeichen", () => {
  const v = "=?UTF-8?B?w5w=?= =?UTF-8?B?YmVyc2ljaHQ=?=";
  assert.equal(decodeHeaderValue(v), "Übersicht");
});

test("lässt reinen ASCII-Text unangetastet", () => {
  assert.equal(decodeHeaderValue("Max Mustermann <a@b.de>"), "Max Mustermann <a@b.de>");
});

test("kodiert Namen nur wenn nötig", () => {
  assert.equal(encodeDisplayName("Max Mustermann"), "Max Mustermann");
  assert.equal(encodeDisplayName("Mustermann, Max"), '"Mustermann, Max"');
  assert.equal(decodeHeaderValue(encodeDisplayName("Jörg Öztürk")), "Jörg Öztürk");
});

test("parst Adressformen", () => {
  assert.deepEqual(parseAddress("Max Mustermann <max@example.de>"), {
    name: "Max Mustermann",
    email: "max@example.de",
  });
  assert.deepEqual(parseAddress("<max@example.de>"), { name: "", email: "max@example.de" });
  assert.deepEqual(parseAddress("max@example.de"), { name: "", email: "max@example.de" });
  assert.deepEqual(parseAddress('"Mustermann, Max" <max@example.de>'), {
    name: "Mustermann, Max",
    email: "max@example.de",
  });
  assert.deepEqual(parseAddress("=?UTF-8?B?TcO8bGxlcg==?= <m@x.de>"), {
    name: "Müller",
    email: "m@x.de",
  });
});

test("splittet Listen ohne an Namens-Kommas zu zerbrechen", () => {
  const list = splitAddressList('"Mustermann, Max" <a@b.de>, Eva <e@f.de>');
  assert.equal(list.length, 2);
  assert.deepEqual(
    parseAddressList('"Mustermann, Max" <a@b.de>, Eva <e@f.de>').map((r) => r.email),
    ["a@b.de", "e@f.de"]
  );
});

test("Round-Trip Liste", () => {
  const v = formatAddressList([
    { name: "Jörg Öztürk", email: "j@x.de" },
    { name: "", email: "b@y.de" },
  ]);
  const back = parseAddressList(v);
  assert.equal(back[0].name, "Jörg Öztürk");
  assert.equal(back[1].email, "b@y.de");
  assert.equal(formatAddress({ name: "", email: "b@y.de" }), "b@y.de");
});

test("Adress-Plausibilität", () => {
  assert.ok(isPlausibleEmail("max@example.de"));
  assert.ok(!isPlausibleEmail("max@example"));
  assert.ok(!isPlausibleEmail("max example.de"));
  assert.ok(!isPlausibleEmail(""));
});
