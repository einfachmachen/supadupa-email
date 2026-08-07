import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareTexts,
  classify,
  extractFacts,
  compareFacts,
  stripQuotes,
  htmlToText,
  normalize,
} from "../lib/similarity.js";
import { checkAttachment, checkAttachments, suggestName, splitName } from "../lib/attachments.js";

const MAIL_A = `Guten Tag,

anbei die Rechnung 2024-0815 über 1.234,56 € vom 03.04.2024.
Bitte überweisen Sie auf DE02 1203 0000 0000 2020 51.

Viele Grüße`;

test("gleicher Text = 100 %", () => {
  const r = compareTexts(MAIL_A, MAIL_A);
  assert.equal(Math.round(r.score * 100), 100);
  assert.equal(classify(r.score).key, "identisch");
});

test("Zitate und Signatur fallen aus dem Vergleich", () => {
  const withQuote = MAIL_A + "\n\n> alte Nachricht mit ganz anderem Inhalt\n-- \nSignatur GmbH";
  const r = compareTexts(MAIL_A, withQuote);
  assert.ok(r.score > 0.95, `score=${r.score}`);
  assert.ok(!stripQuotes(withQuote).includes("Signatur GmbH"));
});

test("anderer Inhalt bleibt klar unterscheidbar", () => {
  const r = compareTexts(MAIL_A, "Ihre Bestellung wurde versendet. Sendungsnummer 99.");
  assert.ok(r.score < 0.3, `score=${r.score}`);
  assert.equal(classify(r.score).key, "verschieden");
});

test("HTML-Fassung derselben Mail zählt als gleich", () => {
  const html =
    "<p>Guten Tag,</p><p>anbei die Rechnung 2024-0815 über 1.234,56 &euro; vom 03.04.2024.<br>" +
    "Bitte überweisen Sie auf DE02 1203 0000 0000 2020 51.</p><p>Viele Grüße</p>";
  const r = compareTexts(htmlToText(html), MAIL_A);
  assert.ok(r.score > 0.55, `score=${r.score}`);
  assert.ok(!htmlToText(html).includes("<p>"));
});

test("Normalisierung glättet Leerraum und Anführungszeichen", () => {
  assert.equal(normalize("„Hallo“   Welt!"), "hallo welt");
});

test("Fakten werden erkannt", () => {
  const f = extractFacts(MAIL_A);
  assert.deepEqual(f.amounts, ["1.234,56 €"]);
  assert.deepEqual(f.ibans, ["DE02120300000000202051"]);
  assert.ok(f.dates.includes("03.04.2024"));
  assert.ok(f.docNumbers.some((d) => d.includes("2024-0815")));
});

test("abweichender Betrag fällt trotz hoher Ähnlichkeit auf", () => {
  const b = MAIL_A.replace("1.234,56", "1.243,56");
  const cmp = compareFacts(MAIL_A, b);
  assert.ok(!cmp.equal);
  assert.deepEqual(cmp.diff.amounts.onlyA, ["1.234,56 €"]);
  assert.deepEqual(cmp.diff.amounts.onlyB, ["1.243,56 €"]);
});

// ------------------------------------------------------------------ Anhänge

const CTX = { subject: "Rechnung 2024-0815", body: MAIL_A, date: "2024-04-03T10:00:00Z" };

test("sprechender Name mit Belegnummer ist plausibel", () => {
  const r = checkAttachment(
    { name: "Rechnung_2024-0815.pdf", contentType: "application/pdf", size: 52000 },
    CTX
  );
  assert.deepEqual(r.findings, []);
  assert.ok(r.plausible);
});

test("nichtssagende Namen werden gemeldet", () => {
  for (const name of ["ATT00001.pdf", "Dokument1.pdf", "scan_0001.pdf", "image001.png", "unbenannt.pdf"]) {
    const r = checkAttachment({ name, contentType: "application/pdf", size: 1000 }, CTX);
    assert.ok(
      r.findings.some((f) => f.code === "generic-name"),
      `${name} → ${JSON.stringify(r.findings)}`
    );
  }
});

test("Endung passt nicht zum Typ", () => {
  const r = checkAttachment({ name: "Rechnung_2024-0815.doc", contentType: "application/pdf", size: 900 }, CTX);
  assert.ok(r.findings.some((f) => f.code === "type-mismatch"));
});

test("gefährliche und getarnte Endungen", () => {
  const exe = checkAttachment({ name: "Rechnung.exe", contentType: "application/octet-stream", size: 10 }, CTX);
  assert.ok(exe.findings.some((f) => f.code === "risky-ext"));
  const tarn = checkAttachment({ name: "Rechnung.pdf.js", contentType: "text/plain", size: 10 }, CTX);
  assert.ok(tarn.findings.some((f) => f.code === "double-ext"));
});

test("leerer Anhang und fehlender Name", () => {
  const r = checkAttachment({ name: "", contentType: "application/pdf", size: 0 }, CTX);
  const c = r.findings.map((f) => f.code);
  assert.ok(c.includes("no-name"));
  assert.ok(c.includes("empty"));
});

test("Belegnummer fehlt im Dateinamen", () => {
  const r = checkAttachment({ name: "Anlage-Kundendienst.pdf", contentType: "application/pdf", size: 5000 }, CTX);
  assert.ok(r.findings.some((f) => f.code === "no-ref"));
});

test("angekündigter, aber fehlender Anhang", () => {
  const res = checkAttachments([], CTX);
  assert.ok(res.findings.some((f) => f.code === "announced-missing"));
});

test("doppelte Dateinamen", () => {
  const res = checkAttachments(
    [
      { name: "Rechnung_2024-0815.pdf", contentType: "application/pdf", size: 100 },
      { name: "rechnung_2024-0815.pdf", contentType: "application/pdf", size: 100 },
    ],
    CTX
  );
  assert.ok(res.findings.some((f) => f.code === "duplicate-names"));
});

test("Namensvorschlag enthält Datum, Betreff und Belegnummer", () => {
  const s = suggestName({ name: "ATT00001.pdf" }, CTX);
  assert.match(s, /^2024-04-03_/);
  assert.match(s, /Rechnung/i);
  assert.match(s, /\.pdf$/);
  assert.deepEqual(splitName("a.b.pdf"), { base: "a.b", ext: "pdf" });
});
