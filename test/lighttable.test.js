import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, clean, comparable, describeJunk, hasJunk } from "../lib/textclean.js";
import {
  collectCandidates,
  collectAttachments,
  pickDefaults,
  overlayLines,
  bestAttachmentName,
} from "../lib/candidates.js";
import { assembleMessage, toQuotedPrintable, makeBoundary } from "../lib/assemble.js";
import { stringToBytes, decodeLatin1, splitMessage, getHeader } from "../lib/rawmail.js";
import { listParts, listAttachmentParts, extractPart } from "../lib/mimeparts.js";
import { contentKey, factKey, verifyGroup, groupDuplicates } from "../lib/dedupe.js";

const ZW = "​";
const NBSP = " ";
const SHY = "­";
const BOM = "﻿";
const RLM = "‏";

// ------------------------------------------------------------- Zeichenmüll

test("Steuer- und Sonderzeichen werden erkannt und entfernt", () => {
  const dirty = `Hallo${ZW}Welt${NBSP}hier${SHY}${BOM}${RLM} Text`;
  const { text, findings } = cleanText(dirty);
  assert.equal(text, "HalloWelt hier Text");
  const codes = findings.map((f) => f.code).sort();
  assert.deepEqual(codes, ["bidi", "c0", "nbsp", "softhyphen", "zerowidth"].sort());
  assert.ok(hasJunk(dirty));
  assert.match(describeJunk(dirty), /Zero-Width/);
});

test("Quoted-Printable-Reste und weiche Umbrüche verschwinden", () => {
  const { text } = cleanText("Zeile eins =20\nZeile =\nzwei");
  assert.equal(text, "Zeile eins\nZeile zwei");
});

test("Trennlinie wird als Rahmen entfernt, ohne Zeilen zu verkleben", () => {
  const { text } = cleanText("Oben\n======\nUnten");
  assert.match(text, /^Oben\n+Unten$/, JSON.stringify(text));
});

test("Rahmen aus Sonderzeichen fällt weg, echter Text nicht", () => {
  const { text } = cleanText("****************\nRechnung 2024-0815\n****************");
  assert.equal(text, "Rechnung 2024-0815");
});

test("Vergleichsform macht verschmutzte und saubere Fassung gleich", () => {
  const sauber = "Guten Tag,\n\nanbei die Rechnung.";
  const dreckig = `Guten${NBSP}Tag,\n\n${ZW}anbei die${SHY} Rechnung.${BOM}`;
  assert.equal(comparable(sauber), comparable(dreckig));
  assert.notEqual(clean(sauber), dreckig);
});

test("Prüfsumme trägt trotz Zeichenmüll — genau darum geht es", () => {
  const a = { bodyText: "Rechnung über 100 €", attachments: [] };
  const b = { bodyText: `Rechnung${NBSP}über${ZW} 100 €`, attachments: [] };
  assert.equal(contentKey(a), contentKey(b));
});

test("Fakten-Fingerabdruck holt eine textlich verhunzte Kopie zurück", () => {
  const base = { subject: "Rechnung", author: "F <f@x.de>", date: "2024-04-03T10:00:00Z", size: 10 };
  const headers = [1, 2, 3].map((id) => ({ ...base, id, headerMessageId: "" }));
  const [group] = groupDuplicates(headers, {});

  const gut = "Rechnung 2024-0815 über 1.234,56 € vom 03.04.2024";
  const contents = new Map([
    [1, { bodyText: gut, attachments: [] }],
    [2, { bodyText: gut, attachments: [] }],
    // Kopie 3: Text zerschossen, aber dieselben harten Fakten
    [3, { bodyText: "Rechnung 2024-0815 über 1.234,56 € vom 03.04.2024 ##ǁ## @@@ Übertragungsfehler xyz", attachments: [] }],
  ]);
  assert.notEqual(contentKey(contents.get(1)), contentKey(contents.get(3)));
  assert.equal(factKey(contents.get(1)), factKey(contents.get(3)));

  const verified = verifyGroup(group, contents);
  assert.equal(verified.length, 1);
  assert.deepEqual(verified[0].messages.map((m) => m.id).sort(), [1, 2, 3]);
});

// -------------------------------------------------------------- Kandidaten

const copies = [
  {
    id: 1,
    subject: "Rechnung 2024-0815",
    from: "Firma <buchhaltung@firma.de>",
    to: "max@example.de",
    cc: "",
    date: "2024-04-03T10:00:00Z",
    bodyText: `Guten Tag,${NBSP}\n\nanbei die Rechnung 2024-0815 über 1.234,56 €.\nMit freundlichen Grüßen`,
    attachments: [
      { index: 1, name: "ATT00001.pdf", contentType: "application/pdf", size: 5000 },
      { index: 2, name: "", contentType: "application/pdf", size: 7000 },
    ],
  },
  {
    id: 2,
    subject: "AW: Rechnung 2024-0815",
    from: "Firma <buchhaltung@firma.de>",
    to: "Max Mustermann <max@example.de>",
    cc: "steuer@kanzlei.de",
    date: "2024-04-03T10:00:05Z",
    bodyText: "Guten Tag,\n\nanbei die Rechnung 2024-0815 über 1.234,56 €.",
    attachments: [
      { index: 1, name: "Rechnung_2024-0815.pdf", contentType: "application/pdf", size: 5000 },
    ],
  },
];

const PROFILES = [
  { id: "1", preferredName: "Max Mustermann", names: [], emails: ["max@example.de"] },
];

test("Kandidaten aller Bestandteile werden gesammelt", () => {
  const c = collectCandidates(copies, { profiles: PROFILES });
  assert.equal(c.subjects.length, 1, "AW:-Vorsatz zählt als derselbe Betreff");
  assert.deepEqual(c.subjects[0].sources, [1, 2]);
  assert.equal(c.froms.length, 1);
  assert.equal(c.tos.length, 2);
  assert.equal(c.tos[0].value, "Max Mustermann <max@example.de>", "beste Empfänger-Fassung zuerst");
  assert.equal(c.ccs.length, 2);
  assert.equal(c.bodies.length, 2);
});

test("Anhänge aus ALLEN Kopien landen in einer Liste", () => {
  const atts = collectAttachments(copies);
  assert.equal(atts.length, 2, "5000er und 7000er Anhang");
  const fuenf = atts.find((a) => a.size === 5000);
  assert.deepEqual(fuenf.names, ["ATT00001.pdf", "Rechnung_2024-0815.pdf"]);
  assert.equal(fuenf.sources.length, 2);
  const sieben = atts.find((a) => a.size === 7000);
  assert.equal(sieben.sources.length, 1, "der nur in Kopie 1 vorhandene Anhang fehlt nicht");
});

test("Vorauswahl nimmt saubere Fassung, guten Namen und alle Anhänge", () => {
  const c = collectCandidates(copies, { profiles: PROFILES });
  const sel = pickDefaults(c, { profiles: PROFILES });
  assert.equal(sel.to, "Max Mustermann <max@example.de>");
  assert.equal(sel.subject, "Rechnung 2024-0815");
  assert.ok(!sel.bodyText.includes(NBSP), "gesäuberter Text");
  assert.equal(sel.attachments.length, 2);
  assert.ok(sel.attachments.every((a) => a.include));
  const fuenf = sel.attachments.find((a) => a.filename === "Rechnung_2024-0815.pdf");
  assert.ok(fuenf, JSON.stringify(sel.attachments));
  const sieben = sel.attachments.find((a) => a !== fuenf);
  assert.match(sieben.filename, /\.pdf$/);
  assert.match(sieben.reason, /keinen Namen|gebildet/);
});

test("fehlender Empfänger-Name wird als Korrektur angeboten", () => {
  const c = collectCandidates([copies[0]], { profiles: PROFILES });
  assert.equal(c.tos[0].suggestion, "Max Mustermann <max@example.de>");
  assert.ok(c.tos[0].issues.length);
});

test("Überlagerung markiert gemeinsame und einzelne Zeilen", () => {
  const c = collectCandidates(copies, { profiles: PROFILES });
  const lines = overlayLines(c.bodies);
  const common = lines.find((l) => l.text.startsWith("anbei die Rechnung"));
  assert.ok(common.inAll, "Kernsatz steht in allen Fassungen");
  const only = lines.find((l) => l.text.includes("freundlichen"));
  assert.ok(only && !only.inAll && only.sources.length === 1);
});

test("bester Anhangsname: vorhandener plausibler schlägt gebildeten", () => {
  const att = {
    key: "x",
    size: 5000,
    contentType: "application/pdf",
    names: ["ATT00001.pdf", "Rechnung_2024-0815.pdf"],
    sources: [{ copyId: 1, name: "ATT00001.pdf" }, { copyId: 2, name: "Rechnung_2024-0815.pdf" }],
  };
  const best = bestAttachmentName(att, { subject: "Rechnung 2024-0815", body: "Rechnung 2024-0815" });
  assert.equal(best.name, "Rechnung_2024-0815.pdf");
});

// --------------------------------------------------------- Zusammenbauen

const B64 = "JVBERi0xLjQKJSVFT0Y=";
const SRC = [
  "From: Firma <f@x.de>",
  "To: alt@x.de",
  "Subject: Alt",
  'Content-Type: multipart/mixed; boundary="G"',
  "",
  "--G",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Text",
  "--G",
  'Content-Type: application/pdf; name="ATT00001.pdf"',
  'Content-Disposition: attachment; filename="ATT00001.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  B64,
  "--G--",
  "",
].join("\r\n");

test("Quoted-Printable kodiert Umlaute und hält Zeilen kurz", () => {
  const qp = toQuotedPrintable("Grüße über alle Berge");
  assert.match(qp, /Gr=C3=BC=C3=9Fe/);
  for (const line of qp.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.notEqual(makeBoundary(), makeBoundary());
});

test("neue Nachricht ohne Anhang ist gültig und trägt die gewählten Kopfdaten", () => {
  const bytes = assembleMessage({
    headers: {
      from: "Firma <f@x.de>",
      to: "Max Mustermann <max@example.de>",
      subject: "Rechnung 2024-0815",
      date: "2024-04-03T10:00:00Z",
    },
    bodyText: "Guten Tag,\n\nanbei die Rechnung.",
  });
  const text = decodeLatin1(bytes);
  const head = splitMessage(bytes).headerText;
  assert.equal(getHeader(head, "To"), "Max Mustermann <max@example.de>");
  assert.equal(getHeader(head, "Subject"), "Rechnung 2024-0815");
  assert.match(getHeader(head, "Message-ID"), /^<.+@.+>$/);
  assert.match(head, /MIME-Version: 1\.0/);
  assert.ok(text.includes("anbei die Rechnung."));
});

test("Anhang wird byte-genau aus einer anderen Mail übernommen und umbenannt", () => {
  const src = stringToBytes(SRC);
  const part = listAttachmentParts(src)[0];
  const taken = extractPart(src, part);

  const bytes = assembleMessage({
    headers: { from: "F <f@x.de>", to: "Max <max@example.de>", subject: "Neu" },
    bodyText: "Neuer Text",
    attachments: [
      { ...taken, filenameOriginal: taken.filename, filename: "Rechnung_2024-0815.pdf" },
    ],
  });

  const text = decodeLatin1(bytes);
  assert.ok(text.includes(B64), "Nutzlast unverändert übernommen");
  assert.ok(!text.includes("ATT00001.pdf"), "alter Name ist weg");

  const parts = listParts(bytes);
  assert.equal(parts[0].contentType, "multipart/mixed");
  const atts = listAttachmentParts(bytes);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, "Rechnung_2024-0815.pdf");
  assert.equal(atts[0].encoding, "base64");
});

test("Anhänge aus mehreren Quellen landen in EINER neuen Nachricht", () => {
  const a = stringToBytes(SRC);
  const b = stringToBytes(SRC.replace("ATT00001.pdf", "Anlage.pdf").replace(B64, "QUJD"));
  const partA = extractPart(a, listAttachmentParts(a)[0]);
  const partB = extractPart(b, listAttachmentParts(b)[0]);

  const bytes = assembleMessage({
    headers: { from: "F <f@x.de>", to: "Max <max@example.de>", subject: "Zusammengesetzt" },
    bodyText: "Text",
    attachments: [
      { ...partA, filenameOriginal: partA.filename, filename: "Rechnung.pdf" },
      { ...partB, filenameOriginal: partB.filename, filename: "Anlage_2024.pdf" },
    ],
  });

  const atts = listAttachmentParts(bytes);
  assert.equal(atts.length, 2);
  assert.deepEqual(atts.map((x) => x.filename), ["Rechnung.pdf", "Anlage_2024.pdf"]);
  const text = decodeLatin1(bytes);
  assert.ok(text.includes(B64) && text.includes("QUJD"), "beide Nutzlasten enthalten");
});

test("Umlaut-Betreff und Umlaut-Dateiname überstehen den Bau", () => {
  const src = stringToBytes(SRC);
  const part = extractPart(src, listAttachmentParts(src)[0]);
  const bytes = assembleMessage({
    headers: { from: "F <f@x.de>", to: "Jörg <j@x.de>", subject: "Grüße & Rechnung" },
    bodyText: "Hallo Jörg",
    attachments: [{ ...part, filenameOriginal: part.filename, filename: "Rechnung Jörg.pdf" }],
  });
  const head = splitMessage(bytes).headerText;
  assert.match(getHeader(head, "Subject"), /^=\?UTF-8\?B\?/);
  assert.equal(listAttachmentParts(bytes)[0].filename, "Rechnung Jörg.pdf");
});
