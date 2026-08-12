import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createReview,
  setMark,
  markOf,
  nextIndex,
  overview,
  groupByMark,
  markCounts,
  pendingGroups,
  describePlan,
  MARKS,
} from "../lib/review.js";
import { buildRebuild } from "../lib/rebuild.js";
import { withFakeMessenger } from "./helpers/fakeMessenger.js";
import { listParts } from "../lib/mimeparts.js";
import { getHeader, splitMessage } from "../lib/rawmail.js";

const g = (key, n = 2) => ({
  key,
  messages: Array.from({ length: n }, (_, i) => ({ id: Number(`${key}${i}`), subject: `Betreff ${key}` })),
});

test("Vormerken verändert nichts, es sammelt nur", () => {
  const groups = [g("1"), g("2"), g("3")];
  let r = createReview(groups);
  assert.equal(markCounts(r).decided, 0);

  r = setMark(r, "1", MARKS.merge);
  r = setMark(r, "2", MARKS.delete);
  assert.equal(markOf(r, "1"), MARKS.merge);
  assert.equal(markOf(r, "3"), MARKS.none);
  // Die Gruppen selbst bleiben unangetastet
  assert.deepEqual(r.groups, groups);
});

test("dieselbe Vormerkung nochmal hebt sie auf", () => {
  let r = createReview([g("1")]);
  r = setMark(r, "1", MARKS.later);
  assert.equal(markOf(r, "1"), MARKS.later);
  r = setMark(r, "1", MARKS.later);
  assert.equal(markOf(r, "1"), MARKS.none, "zweiter Klick nimmt zurück");
});

test("Zählung nach Art", () => {
  let r = createReview([g("1"), g("2"), g("3"), g("4")]);
  r = setMark(r, "1", MARKS.merge);
  r = setMark(r, "2", MARKS.merge);
  r = setMark(r, "3", MARKS.delete);
  const c = markCounts(r);
  assert.deepEqual([c.merge, c.delete, c.later, c.none], [2, 1, 0, 1]);
  assert.equal(c.decided, 3);
  const by = groupByMark(r);
  assert.deepEqual(by.merge.map((x) => x.key), ["1", "2"]);
});

test("Übersicht rechnet eindeutige Nachrichten aus", () => {
  // 100 Nachrichten, 3 Gruppen mit je 2/3/4 Kopien = 9 Kopien in Gruppen
  const groups = [g("a", 2), g("b", 3), g("c", 4)];
  const ov = overview(groups, 100);
  assert.equal(ov.inGroups, 9);
  assert.equal(ov.singles, 91, "Nachrichten ohne Dublette");
  assert.equal(ov.unique, 94, "91 Einzelstücke + 3 Gruppen");
  assert.equal(ov.removable, 6, "je Gruppe bleibt eine Kopie");
});

test("nächste offene Gruppe wird gefunden", () => {
  let r = createReview([g("1"), g("2"), g("3")]);
  r = setMark(r, "2", MARKS.merge);
  assert.equal(nextIndex(r, { from: 0 }), 1);
  assert.equal(nextIndex(r, { from: 0, onlyUnmarked: true }), 2, "übergeht die entschiedene");
  assert.equal(nextIndex(r, { from: 2 }), -1, "am Ende");
});

test("der Plan sagt im Klartext, was passieren wird", () => {
  let r = createReview([g("1", 3), g("2", 2), g("3")]);
  r = setMark(r, "1", MARKS.merge);
  r = setMark(r, "2", MARKS.delete);
  r = setMark(r, "3", MARKS.later);
  const lines = describePlan(r).join(" | ");
  assert.match(lines, /1 Gruppe\(n\) zusammenfassen: aus 3 Kopien/);
  assert.match(lines, /1 Gruppe\(n\) bereinigen: 1 Kopie\(n\) in den Papierkorb/);
  assert.match(lines, /1 Gruppe\(n\) bleiben für später/);
});

// ---------------------------------------------- gemeinsamer Neubau-Baustein

test("Stapel-Neubau liefert dasselbe wie der Leuchttisch mit Vorauswahl", async () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("./fixtures/inline-and-attachment.eml", import.meta.url))
  );
  const { restore } = withFakeMessenger([{ id: 7, bytes }]);
  try {
    const store = await import("../lib/messageStore.js");
    const loaded = await store.loadForLightTable(7);
    loaded.inline = store.inlineImageList(loaded);

    const { bytes: built, report } = buildRebuild([loaded], { profiles: [] });
    assert.equal(report.copies, 1);
    assert.equal(report.attachments, 2, "PDF und JPG — Inline-Bilder stecken im Rumpf");
    assert.equal(report.inlineImages, 3);
    assert.ok(report.keptHtml);

    const parts = listParts(built);
    assert.equal(parts.filter((p) => p.contentId).length, 3);
    assert.equal(parts.filter((p) => p.isAttachment).length, 2);
    const head = splitMessage(built).headerText;
    assert.match(getHeader(head, "X-SupaDupa-Merged-From"), /^7$/);
  } finally {
    restore();
  }
});

test("ohne Formatierung wandern die eingebundenen Bilder als Anhang mit", async () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("./fixtures/inline-and-attachment.eml", import.meta.url))
  );
  const { restore } = withFakeMessenger([{ id: 7, bytes }]);
  try {
    const store = await import("../lib/messageStore.js");
    const loaded = await store.loadForLightTable(7);
    loaded.inline = store.inlineImageList(loaded);

    const { collectCandidates, pickDefaults } = await import("../lib/candidates.js");
    const cands = collectCandidates([loaded], { profiles: [] });
    const sel = pickDefaults(cands, { profiles: [] });
    // Wie die Oberfläche es tut, wenn „Formatierung behalten" ausgeht:
    for (const st of sel.attachments) {
      const meta = cands.attachments.find((a) => a.key === st.key);
      if (meta?.inlineToo) st.include = true;
    }

    const { report } = buildRebuild([loaded], { profiles: [], keepHtml: false, selection: sel });
    assert.equal(report.keptHtml, false);
    assert.equal(report.inlineImages, 0);
    assert.equal(report.attachments, 5, "3 Bilder + PDF + JPG hängen jetzt dran");
  } finally {
    restore();
  }
});

test("Übersicht behält offene und „später“-Gruppen, Vormerkungen wandern weg", () => {
  const groups = [g("a"), g("b"), g("c"), g("d")];
  let r = createReview(groups);
  r = setMark(r, "a", MARKS.merge);
  r = setMark(r, "b", MARKS.delete);
  r = setMark(r, "c", MARKS.later);
  assert.deepEqual(
    pendingGroups(r).map((x) => x.key),
    ["c", "d"]
  );
  // Ohne Entscheidung steht alles noch oben
  assert.equal(pendingGroups(createReview(groups)).length, 4);
});
