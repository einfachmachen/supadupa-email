import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImagePool,
  auditInlineImages,
  summarizeInline,
  inlineSetForRebuild,
  dataUrlToBytes,
} from "../lib/inlineparts.js";
import { listCidRefs, cidStem, buildReaderDocument } from "../lib/htmlmail.js";
import { assembleMessage } from "../lib/assemble.js";
import { listParts, listAttachmentParts, extractPart, decodeBody } from "../lib/mimeparts.js";
import { splitMessage, getHeader, decodeLatin1 } from "../lib/rawmail.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const OTHER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 9]);
const OTHER_URL = `data:image/png;base64,${Buffer.from(OTHER).toString("base64")}`;

const HTML = `<div><p>Text</p>
<img src="cid:image001.png@01D71B1D.EEA0B4F0">
<img src="cid:image002.png@01D71B1D.EEA0B4F0"></div>`;

test("cid-Verweise und Namensteil werden gelesen", () => {
  assert.deepEqual(listCidRefs(HTML), [
    "image001.png@01D71B1D.EEA0B4F0",
    "image002.png@01D71B1D.EEA0B4F0",
  ]);
  assert.equal(cidStem("image001.png@01D71B1D.EEA0B4F0"), "image001.png");
  assert.equal(cidStem("ohne-at"), "ohne-at");
});

test("Bild aus einer Geschwister-Kopie füllt die Lücke", () => {
  // Kopie 1 zeigt das HTML, hat aber keine Bilder mehr.
  // Kopie 2 trägt dasselbe Bild unter ANDERER Content-ID (Outlook-Muster).
  const copies = [
    { id: 1, inline: [] },
    {
      id: 2,
      inline: [
        { cid: "image001.png@99XX.YYY", contentType: "image/png", size: PNG.length, dataUrl: PNG_URL },
      ],
    },
  ];
  const pool = buildImagePool(copies);
  const audit = auditInlineImages(HTML, pool);
  assert.equal(audit[0].state, "ersetzt");
  assert.equal(audit[0].from, 2);
  assert.equal(audit[1].state, "fehlt");

  const s = summarizeInline(audit);
  assert.deepEqual([s.ok, s.filled, s.missing], [0, 1, 1]);
  assert.match(s.text, /ergänzt/);
});

test("eigene Bilder gelten als vorhanden", () => {
  const pool = buildImagePool([
    {
      id: 1,
      inline: [
        { cid: "image001.png@01D71B1D.EEA0B4F0", contentType: "image/png", size: 11, dataUrl: PNG_URL },
      ],
    },
  ]);
  const audit = auditInlineImages(HTML, pool);
  assert.equal(audit[0].state, "ok");
  assert.equal(audit[0].from, 1);
});

test("bei mehreren Fassungen gewinnt die größere Datei", () => {
  const pool = buildImagePool([
    { id: 1, inline: [{ cid: "image001.png@a", contentType: "image/png", size: 11, dataUrl: PNG_URL }] },
    { id: 2, inline: [{ cid: "image001.png@b", contentType: "image/png", size: 13, dataUrl: OTHER_URL }] },
  ]);
  assert.equal(pool.byStem.get("image001.png"), OTHER_URL);
});

test("der Betrachter setzt ergänzte Bilder ein und meldet es", () => {
  const pool = buildImagePool([
    { id: 2, inline: [{ cid: "image001.png@99XX.YYY", contentType: "image/png", size: 11, dataUrl: PNG_URL }] },
  ]);
  const built = buildReaderDocument(HTML, { images: pool.byCid, stems: pool.byStem });
  assert.equal(built.filled.length, 1);
  assert.equal(built.missingCid, 1, "das zweite Bild fehlt wirklich");
  assert.ok(built.document.includes(PNG_URL));
  assert.ok(built.document.includes('data-filled-from="image001.png"'));
  assert.ok(built.document.includes('data-missing-cid="image002.png@01D71B1D.EEA0B4F0"'));
});

test("data:-URL wird wieder zu Bytes", () => {
  const d = dataUrlToBytes(PNG_URL);
  assert.equal(d.contentType, "image/png");
  assert.deepEqual([...d.bytes], [...PNG]);
  assert.equal(dataUrlToBytes("kein-data-url"), null);
});

// ------------------------------------------------- Neubau mit Bildern im Text

test("neue Nachricht behält HTML samt eingebetteter Bilder", () => {
  const pool = buildImagePool([
    { id: 2, inline: [{ cid: "image001.png@99XX.YYY", contentType: "image/png", size: 11, dataUrl: PNG_URL }] },
  ]);
  const set = inlineSetForRebuild(HTML, pool).map((i) => {
    const d = dataUrlToBytes(i.dataUrl);
    return { cid: i.cid, contentType: d.contentType, bytes: d.bytes };
  });
  assert.equal(set.length, 1);
  assert.equal(set[0].cid, "image001.png@01D71B1D.EEA0B4F0", "unter der IM HTML benutzten ID");

  const doc = buildReaderDocument(HTML, { images: pool.byCid, stems: pool.byStem, showHistory: true });
  const bytes = assembleMessage({
    headers: { from: "F <f@x.de>", to: "Max <max@example.de>", subject: "Mit Bild" },
    bodyText: "Textfassung",
    htmlBody: doc.document,
    inlineImages: set,
  });

  const parts = listParts(bytes);
  const types = parts.map((p) => p.contentType);
  assert.ok(types.includes("multipart/alternative"), types.join(", "));
  assert.ok(types.includes("multipart/related"), types.join(", "));
  assert.ok(types.includes("text/plain"));
  assert.ok(types.includes("text/html"));

  const img = parts.find((p) => p.contentId);
  assert.ok(img, "Bild-Teil mit Content-ID vorhanden");
  assert.equal(img.contentId, "image001.png@01D71B1D.EEA0B4F0");
  assert.deepEqual([...decodeBody(extractPart(bytes, img))], [...PNG], "Bildbytes unverändert");
  assert.ok(!img.isAttachment, "zählt als Textbestandteil, nicht als Anhang");
});

test("Neubau mit Bild UND Dateianhang bleibt gültig verschachtelt", () => {
  const pool = buildImagePool([
    { id: 1, inline: [{ cid: "image001.png@01D71B1D.EEA0B4F0", contentType: "image/png", size: 11, dataUrl: PNG_URL }] },
  ]);
  const set = inlineSetForRebuild(HTML, pool).map((i) => {
    const d = dataUrlToBytes(i.dataUrl);
    return { cid: i.cid, contentType: d.contentType, bytes: d.bytes };
  });
  const pdf = {
    headerText:
      'Content-Type: application/pdf; name="Rechnung.pdf"\r\n' +
      'Content-Disposition: attachment; filename="Rechnung.pdf"\r\n' +
      "Content-Transfer-Encoding: base64\r\n\r\n",
    body: new TextEncoder().encode("JVBERg==\r\n"),
    filename: "Rechnung.pdf",
    filenameOriginal: "Rechnung.pdf",
    encoding: "base64",
    contentType: "application/pdf",
  };

  const bytes = assembleMessage({
    headers: { from: "F <f@x.de>", to: "Max <max@example.de>", subject: "Beides" },
    bodyText: "Text",
    htmlBody: "<p>Hallo</p>" + HTML,
    inlineImages: set,
    attachments: [pdf],
  });

  const head = splitMessage(bytes).headerText;
  assert.match(getHeader(head, "Content-Type"), /^multipart\/mixed/);
  const atts = listAttachmentParts(bytes);
  assert.equal(atts.length, 1, "genau ein Dateianhang");
  assert.equal(atts[0].filename, "Rechnung.pdf");
  const withCid = listParts(bytes).filter((p) => p.contentId);
  assert.equal(withCid.length, 1, "das Inline-Bild steckt zusätzlich drin");
  assert.ok(decodeLatin1(bytes).includes("JVBERg=="), "PDF-Nutzlast unverändert");
});

test("ohne HTML bleibt es wie bisher eine reine Textnachricht", () => {
  const bytes = assembleMessage({
    headers: { from: "F <f@x.de>", to: "Max <max@example.de>", subject: "Nur Text" },
    bodyText: "Hallo",
  });
  const head = splitMessage(bytes).headerText;
  assert.match(getHeader(head, "Content-Type"), /^text\/plain/);
  assert.equal(listParts(bytes).length, 1);
});
