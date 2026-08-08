import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withFakeMessenger } from "./helpers/fakeMessenger.js";
import { listParts, extractPart, decodeBody } from "../lib/mimeparts.js";
import { buildReaderDocument } from "../lib/htmlmail.js";
import { buildImagePool, auditInlineImages, summarizeInline, inlineSetForRebuild, dataUrlToBytes } from "../lib/inlineparts.js";
import { collectCandidates, pickDefaults } from "../lib/candidates.js";
import { assembleMessage } from "../lib/assemble.js";

const fixture = (name) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Führt den echten Weg über die API-Attrappe aus. */
async function loadVia(bytes) {
  const { restore } = withFakeMessenger([{ id: 7, bytes }]);
  try {
    const store = await import("../lib/messageStore.js");
    const loaded = await store.loadForLightTable(7);
    loaded.inline = store.inlineImageList(loaded);
    return loaded;
  } finally {
    restore();
  }
}

// Nachbau einer echten Nachricht: drei PNG sind IM TEXT eingebunden und
// zusätzlich als Anhang deklariert, dazu zwei echte Dateianhänge.
test("Bilder im Text landen im Lesedokument, Dateien in der Anhangsliste", async () => {
  const loaded = await loadVia(fixture("inline-and-attachment.eml"));

  assert.ok(loaded.isHtml, "wird als HTML-Mail erkannt");
  assert.equal(loaded.inline.length, 3, "drei eingebettete Bilder");
  assert.equal(
    loaded.attachments.length,
    8,
    "nichts verschwindet: 3 Bilder + PDF + JPG + drei Winzlinge"
  );

  const names = loaded.attachments.map((a) => a.name);
  assert.ok(names.includes("Einkaufsliste BAUHAUS Rollladendämmung.pdf"));
  assert.ok(names.includes("offener Kasten.jpg"));
  assert.equal(
    loaded.attachments.filter((a) => a.inlineToo).length,
    3,
    "die drei PNG sind als auch-im-Text markiert"
  );

  const pool = buildImagePool([{ id: 7, inline: loaded.inline }]);
  const audit = auditInlineImages(loaded.html, pool);
  assert.equal(summarizeInline(audit).ok, 3);
  assert.equal(summarizeInline(audit).missing, 0);

  const built = buildReaderDocument(loaded.html, { images: pool.byCid, stems: pool.byStem });
  assert.equal(built.missingCid, 0, "kein grauer Kasten");
  assert.equal((built.document.match(/data:image\/png;base64,/g) || []).length, 3);
  assert.ok(built.document.includes("Einkaufsliste"), "Text erhalten");
});

test("beim Neubau hängen eingebundene Bilder nicht doppelt dran", async () => {
  const loaded = await loadVia(fixture("inline-and-attachment.eml"));
  const cands = collectCandidates([loaded], { profiles: [] });
  const sel = pickDefaults(cands, { profiles: [] });

  const inlineOnes = sel.attachments.filter((a) => a.inlineToo);
  assert.equal(inlineOnes.length, 3);
  assert.ok(
    inlineOnes.every((a) => !a.include),
    "im Text eingebundene Bilder sind in der Anhangsliste abgewählt"
  );
  assert.equal(
    sel.attachments.filter((a) => a.include).length,
    2,
    "nur PDF und JPG kommen als Anhang mit"
  );
});

test("die neu gebaute Nachricht zeigt die Bilder wieder im Text", async () => {
  const loaded = await loadVia(fixture("inline-and-attachment.eml"));
  const pool = buildImagePool([{ id: 7, inline: loaded.inline }]);
  const doc = buildReaderDocument(loaded.html, {
    images: pool.byCid,
    stems: pool.byStem,
    showHistory: true,
  });
  const images = inlineSetForRebuild(loaded.html, pool).map((i) => {
    const d = dataUrlToBytes(i.dataUrl);
    return { cid: i.cid, contentType: d.contentType, bytes: d.bytes };
  });
  assert.equal(images.length, 3);

  // Dateianhänge byte-genau übernehmen (PDF + JPG, ohne die Inline-Bilder)
  // PDF und JPG — ohne die Inline-Bilder und ohne die 0/2/4-Byte-Reste
  const parts = listParts(loaded.bytes).filter(
    (p) => p.isAttachment && !p.contentId && p.bodyEnd - p.headerEnd > 100
  );
  const attachments = parts.map((p) => {
    const ex = extractPart(loaded.bytes, p);
    return { ...ex, filenameOriginal: ex.filename, filename: ex.filename };
  });

  const bytes = assembleMessage({
    headers: { from: loaded.from, to: loaded.to, subject: loaded.subject },
    bodyText: "Klartext-Rückfallebene",
    htmlBody: doc.document,
    inlineImages: images,
    attachments,
  });

  const rebuilt = listParts(bytes);
  const cids = rebuilt.filter((p) => p.contentId);
  assert.equal(cids.length, 3, "drei Bilder im Rumpf");
  assert.deepEqual(
    cids.map((p) => p.contentId).sort(),
    [
      "image001.png@01D71B1D.EEA0B4F0",
      "image002.png@01D71B1D.EEA0B4F0",
      "image003.png@01D71B1D.EEA0B4F0",
    ],
    "unter genau den IDs, die das HTML benutzt"
  );
  const atts = rebuilt.filter((p) => p.isAttachment);
  assert.equal(atts.length, 2, "PDF und JPG — die Bilder hängen NICHT zusätzlich dran");

  // Und die Bilddaten sind unverändert angekommen
  const original = decodeBody(
    extractPart(loaded.bytes, listParts(loaded.bytes).find((p) => p.contentId))
  );
  const copy = decodeBody(extractPart(bytes, cids[0]));
  assert.deepEqual([...copy], [...original]);
});

test("Nachricht ohne HTML: Anhänge bleiben trotzdem vollständig", async () => {
  const loaded = await loadVia(fixture("related-attachments.eml"));
  const names = loaded.attachments.map((a) => a.name).sort();
  assert.equal(loaded.attachments.length, 3, names.join(", "));
  assert.ok(names.includes("verwaist.png"), "verwaistes cid-Bild wird Anhang");
  assert.equal(loaded.inline.length, 2, "beide cid-Bilder stehen als Vorrat bereit");
  assert.equal(
    loaded.attachments.filter((a) => a.name.endsWith(".pdf")).length,
    2,
    "beide PDFs gefunden"
  );
});

test("winzige Teile sind abgewählt, echte Anhänge nicht", async () => {
  const loaded = await loadVia(fixture("inline-and-attachment.eml"));
  const cands = collectCandidates([loaded], { profiles: [] });
  const sel = pickDefaults(cands, { profiles: [] });

  const namesOf = (list) =>
    list
      .map((s) => s.filename)
      .sort()
      .join(", ");

  const tiny = sel.attachments.filter((a) => a.tiny);
  assert.equal(tiny.length, 3, `winzig: ${namesOf(tiny)}`);
  assert.ok(tiny.every((a) => !a.include), "0/2/4-Byte-Teile sind nicht vorausgewählt");

  const chosen = sel.attachments.filter((a) => a.include);
  assert.equal(chosen.length, 2, `gewählt: ${namesOf(chosen)}`);
  assert.ok(
    chosen.some((a) => a.filename.endsWith(".pdf")) &&
      chosen.some((a) => a.filename.endsWith(".jpg")),
    "PDF und JPG bleiben ausgewählt"
  );

  // Nichts verschwindet: die Winzlinge stehen weiterhin in der Liste
  assert.equal(sel.attachments.length, loaded.attachments.length);
});
