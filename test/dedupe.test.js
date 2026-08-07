import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSubject,
  fingerprint,
  groupDuplicates,
  scoreCopy,
  summarize,
  removableIds,
  differences,
  MODES,
} from "../lib/dedupe.js";

const PROFILES = [
  {
    id: "1",
    preferredName: "Max Mustermann",
    names: [],
    emails: ["max@example.de"],
  },
];

const base = {
  subject: "Rechnung 2024-0815",
  author: "Firma <buchhaltung@firma.de>",
  date: "2024-04-03T10:00:00Z",
  size: 40000,
  read: true,
  tags: [],
};

const msg = (id, over = {}) => ({ ...base, id, ...over });

test("Betreff-Normalisierung entfernt Antwort-Vorsätze", () => {
  assert.equal(normalizeSubject("AW: Re: Rechnung  2024-0815"), "rechnung 2024-0815");
  assert.equal(normalizeSubject("Fwd: Test"), "test");
  assert.equal(normalizeSubject("Re[2]: Test"), "test");
});

test("gleiche Message-ID = dieselbe Nachricht, egal was sonst abweicht", () => {
  const a = msg(1, { headerMessageId: "<abc@x>", subject: "Rechnung" });
  const b = msg(2, { headerMessageId: "<abc@x>", subject: "AW: Rechnung", size: 41000 });
  assert.equal(fingerprint(a, MODES.strict), fingerprint(b, MODES.strict));
  assert.equal(fingerprint(a), fingerprint(b));
});

test("ohne Message-ID greift Absender + Betreff + Minute", () => {
  const a = msg(1);
  const b = msg(2, { date: "2024-04-03T10:00:41Z" });
  const c = msg(3, { date: "2024-04-03T11:30:00Z" });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
  assert.equal(fingerprint(a, MODES.lose), fingerprint(c, MODES.lose));
});

test("streng gruppiert nicht, was nur inhaltlich gleich aussieht", () => {
  const a = msg(1, { headerMessageId: "<a@x>" });
  const b = msg(2, { headerMessageId: "<b@x>" });
  assert.notEqual(fingerprint(a, MODES.strict), fingerprint(b, MODES.strict));
  assert.equal(groupDuplicates([a, b], { mode: MODES.strict }).length, 0);
  assert.equal(groupDuplicates([a, b], { mode: MODES.lose }).length, 1);
});

test("die Kopie mit vollständiger Empfänger-Angabe wird behalten", () => {
  const kaputt = msg(1, {
    headerMessageId: "<abc@x>",
    recipients: ["max@example.de"],
  });
  const gut = msg(2, {
    headerMessageId: "<abc@x>",
    recipients: ["Max Mustermann <max@example.de>"],
  });
  const falsch = msg(3, { headerMessageId: "<abc@x>", recipients: ["Eva Beispiel <max@example.de>"] });
  const [g] = groupDuplicates([kaputt, gut, falsch], { profiles: PROFILES });
  assert.equal(g.keeperId, 2);
  assert.deepEqual(removableIds(g).sort(), [1, 3]);
  assert.ok(scoreCopy(gut, PROFILES) > scoreCopy(kaputt, PROFILES));
  assert.ok(scoreCopy(kaputt, PROFILES) > scoreCopy(falsch, PROFILES));
});

test("Kopie ganz ohne Empfänger verliert gegen jede mit", () => {
  const ohne = msg(1, { headerMessageId: "<abc@x>", recipients: [] });
  const mit = msg(2, { headerMessageId: "<abc@x>", recipients: ["max@example.de"] });
  const [g] = groupDuplicates([ohne, mit], { profiles: PROFILES });
  assert.equal(g.keeperId, 2);
});

test("Einzelstücke bilden keine Gruppe", () => {
  const groups = groupDuplicates([msg(1, { headerMessageId: "<a@x>" })], {});
  assert.deepEqual(groups, []);
});

test("Zusammenfassung zählt entfernbare Kopien korrekt", () => {
  const headers = [
    msg(1, { headerMessageId: "<a@x>" }),
    msg(2, { headerMessageId: "<a@x>" }),
    msg(3, { headerMessageId: "<a@x>" }),
    msg(4, { headerMessageId: "<b@x>" }),
    msg(5, { headerMessageId: "<b@x>" }),
    msg(6, { headerMessageId: "<c@x>" }),
  ];
  const groups = groupDuplicates(headers, {});
  const s = summarize(groups);
  assert.equal(s.groups, 2);
  assert.equal(s.total, 5);
  assert.equal(s.removable, 3);
  assert.equal(groups[0].messages.length, 3, "größte Gruppe zuerst");
});

test("Unterschiede innerhalb einer Gruppe werden benannt", () => {
  const d = differences([
    msg(1, { recipients: ["max@example.de"], size: 100 }),
    msg(2, { recipients: ["Max Mustermann <max@example.de>"], size: 200 }),
  ]);
  assert.ok(d.includes("unterschiedliche Empfänger-Angabe"));
  assert.ok(d.includes("unterschiedliche Größe"));
  const gleich = differences([msg(1), msg(2)]);
  assert.deepEqual(gleich, ["keine sichtbaren Unterschiede"]);
});

test("10.000 Kopfdaten gruppieren bleibt schnell", () => {
  const many = Array.from({ length: 10000 }, (_, i) =>
    msg(i, { headerMessageId: `<m${i % 2500}@x>`, recipients: ["max@example.de"] })
  );
  const t0 = Date.now();
  const groups = groupDuplicates(many, { profiles: PROFILES });
  const ms = Date.now() - t0;
  assert.equal(groups.length, 2500);
  assert.equal(summarize(groups).removable, 7500);
  assert.ok(ms < 3000, `Gruppierung dauerte ${ms} ms`);
});
