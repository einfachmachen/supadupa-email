import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listParts, listAttachmentParts, classifyParts, extractPart, decodeBody } from "../lib/mimeparts.js";
import { listCidRefs } from "../lib/htmlmail.js";
import { splitMessage, getHeader } from "../lib/rawmail.js";
import { decodeHeaderValue } from "../lib/mime.js";

// Nachbau einer echten Nachricht (anonymisiert): Outlook packt in
// multipart/related ECHTE Anhänge — mit Content-Disposition: attachment UND
// einer Content-ID. Eine frühere Fassung hielt jeden Teil mit Content-ID für
// ein eingebettetes Bild und ließ beide PDFs komplett verschwinden.
const bytes = new Uint8Array(
  readFileSync(new URL("./fixtures/related-attachments.eml", import.meta.url))
);
const html = (() => {
  const part = listParts(bytes).find((p) => p.contentType === "text/html");
  return new TextDecoder().decode(decodeBody(extractPart(bytes, part)));
})();
const referencedCids = new Set(listCidRefs(html));

test("Anhänge mit Content-ID in multipart/related werden gefunden", () => {
  const atts = listAttachmentParts(bytes);
  const names = atts.map((a) => a.filename);
  assert.equal(atts.length, 2, `gefunden: ${names.join(", ") || "keine"}`);
  assert.ok(names.includes("PKS96_NK_OG_Beispiel_2024.pdf"));
  assert.ok(
    names.includes("Einzelabrechnung_025400618_2024_0002_0_Anna Beispiel_20_01_2025_7.pdf")
  );
});

test("gefaltete, RFC-2047-kodierte Dateinamen werden dekodiert", () => {
  const [first] = listAttachmentParts(bytes);
  assert.ok(!first.filename.includes("=?UTF-8?B?"), first.filename);
  assert.match(first.filename, /\.pdf$/);
});

test("die Nutzlast der Anhänge ist lesbar", () => {
  for (const p of listAttachmentParts(bytes)) {
    const data = decodeBody(extractPart(bytes, p));
    assert.ok(data.length > 0);
    assert.equal(new TextDecoder().decode(data.slice(0, 5)), "%PDF-");
  }
});

test("eingebettetes Bild bleibt Textbestandteil, verwaistes wird Anhang", () => {
  const { attachments, inline } = classifyParts(bytes, { referencedCids });
  const names = attachments.map((a) => a.filename).sort();

  assert.equal(inline.length, 1, "genau das im HTML eingebundene Bild");
  assert.equal(inline[0].filename, "logo.png");
  assert.ok(!names.includes("logo.png"), "das eingebundene Logo ist kein Anhang");

  // Das Bild, das NIEMAND einbindet, darf nicht lautlos verschwinden.
  assert.ok(names.includes("verwaist.png"), `Anhänge: ${names.join(", ")}`);
  assert.equal(attachments.length, 3);
});

test("Kopfdaten der Nachricht bleiben lesbar", () => {
  const head = splitMessage(bytes).headerText;
  assert.equal(
    decodeHeaderValue(getHeader(head, "Subject")),
    "Nebenkostenabrechnung für das Jahr 2024"
  );
  assert.match(decodeHeaderValue(getHeader(head, "From")), /Bernd Muster/);
});

test("ohne cid-Abgleich zählt jeder cid-Teil ohne inline-Angabe als Anhang", () => {
  // Fällt der HTML-Abgleich aus (kein HTML lesbar), bleibt die vorsichtige
  // Variante: lieber ein Eintrag zu viel als eine verlorene Datei.
  const { attachments } = classifyParts(bytes, { referencedCids: new Set() });
  const names = attachments.map((a) => a.filename);
  assert.ok(names.includes("verwaist.png"));
  assert.ok(!names.includes("logo.png"), "explizites inline bleibt inline");
  assert.equal(attachments.length, 3);
});
