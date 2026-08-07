import { test } from "node:test";
import assert from "node:assert/strict";
import { stringToBytes } from "../lib/rawmail.js";
import { listAttachmentParts, extractPart, decodeBody } from "../lib/mimeparts.js";
import { sha256Hex, attachmentKey, sniffType, previewKind, shortHash } from "../lib/attachcontent.js";
import { collectAttachments, pickDefaults, collectCandidates } from "../lib/candidates.js";

const CRLF = "\r\n";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x41]);
const PDF_B64 = Buffer.from(PDF_BYTES).toString("base64");
const PDF_QP = "=25=50=44=46-1.4\n=41";

function mail({ name = "ATT00001.pdf", payload = PDF_B64, enc = "base64" } = {}) {
  return [
    "From: F <f@x.de>",
    "To: a@x.de",
    "Subject: Rechnung 2024-0815",
    'Content-Type: multipart/mixed; boundary="G"',
    "",
    "--G",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Text",
    "--G",
    `Content-Type: application/pdf; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    `Content-Transfer-Encoding: ${enc}`,
    "",
    payload,
    "--G--",
    "",
  ].join(CRLF);
}

function firstAttachment(src) {
  const bytes = stringToBytes(src);
  const part = listAttachmentParts(bytes)[0];
  return decodeBody(extractPart(bytes, part));
}

test("Base64-Nutzlast wird zu den echten Dateibytes dekodiert", () => {
  assert.deepEqual([...firstAttachment(mail())], [...PDF_BYTES]);
});

test("Quoted-Printable-Nutzlast ergibt dieselben Bytes", () => {
  const qp = firstAttachment(mail({ payload: PDF_QP, enc: "quoted-printable" }));
  assert.deepEqual([...qp], [...PDF_BYTES]);
});

test("gleiche Datei, andere Kodierung und anderer Name = gleicher Hash", async () => {
  const a = await sha256Hex(firstAttachment(mail()));
  const b = await sha256Hex(
    firstAttachment(mail({ name: "Rechnung_2024-0815.pdf", payload: PDF_QP, enc: "quoted-printable" }))
  );
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(attachmentKey({ hash: a }), attachmentKey({ hash: b }));
});

test("andere Datei gleicher Größe = anderer Hash", async () => {
  const other = new Uint8Array([...PDF_BYTES]);
  other[other.length - 1] = 0x42;
  const a = await sha256Hex(PDF_BYTES);
  const b = await sha256Hex(other);
  assert.notEqual(a, b);
  assert.notEqual(attachmentKey({ hash: a }), attachmentKey({ hash: b }));
});

test("Hash einer Sicht auf einen größeren Puffer bleibt korrekt", async () => {
  const big = new Uint8Array(64);
  big.set(PDF_BYTES, 20);
  const view = big.subarray(20, 20 + PDF_BYTES.length);
  assert.equal(await sha256Hex(view), await sha256Hex(PDF_BYTES));
});

test("ohne Hash greift der alte Notbehelf aus Größe und Typ", () => {
  const k = attachmentKey({ size: 5000, contentType: "application/pdf" });
  assert.equal(k, "meta:5000|application/pdf");
  assert.notEqual(k, attachmentKey({ size: 5001, contentType: "application/pdf" }));
});

test("Dateityp wird aus den Bytes erkannt", () => {
  assert.equal(sniffType(PDF_BYTES), "application/pdf");
  assert.equal(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "image/png");
  assert.equal(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(sniffType(new Uint8Array([1, 2, 3, 4])), "");
});

test("Vorschau-Einstufung nach Typ und Endung", () => {
  assert.equal(previewKind("application/pdf"), "pdf");
  assert.equal(previewKind("application/octet-stream", "Rechnung.pdf"), "pdf");
  assert.equal(previewKind("image/png"), "image");
  assert.equal(previewKind("text/csv"), "text");
  assert.equal(previewKind("application/octet-stream", "daten.csv"), "text");
  assert.equal(previewKind("application/zip", "archiv.zip"), "none");
  assert.equal(shortHash("abcdef1234567890").length, 10);
});

// ------------------------------------------- Zusammenfassen über den Inhalt

const H_A = "a".repeat(64);
const H_B = "b".repeat(64);

/** 10 Kopien derselben Mail mit je 5 Anhängen, verschieden benannt. */
function tenCopies() {
  const hashes = Array.from({ length: 5 }, (_, i) => String(i).repeat(64));
  return Array.from({ length: 10 }, (_, c) => ({
    id: c + 1,
    subject: "Rechnung 2024-0815",
    from: "F <f@x.de>",
    to: "a@x.de",
    cc: "",
    date: "2024-04-03T10:00:00Z",
    bodyText: "anbei die Rechnung 2024-0815",
    attachments: hashes.map((h, i) => ({
      index: i + 1,
      // Nur eine Kopie hat sprechende Namen, der Rest ist nichtssagend
      name: c === 3 ? `Rechnung_2024-0815_Teil${i + 1}.pdf` : `ATT0000${i + 1}.pdf`,
      contentType: "application/pdf",
      size: 5000 + i,
      hash: h,
    })),
  }));
}

test("10 Kopien mit je 5 Anhängen ergeben genau 5 Einträge", () => {
  const atts = collectAttachments(tenCopies());
  assert.equal(atts.length, 5);
  for (const a of atts) {
    assert.equal(a.sources.length, 10, "jeder Anhang kennt alle 10 Herkünfte");
    assert.equal(a.names.length, 2, "nichtssagender und sprechender Name");
  }
});

test("aus den Namensvarianten gewinnt der plausible", () => {
  const c = collectCandidates(tenCopies(), { profiles: [] });
  const sel = pickDefaults(c, { profiles: [] });
  assert.equal(sel.attachments.length, 5);
  for (const a of sel.attachments) {
    assert.match(a.filename, /Rechnung_2024-0815_Teil\d\.pdf/, JSON.stringify(a));
    assert.ok(a.include);
  }
});

test("verschiedene Dateien gleicher Größe bleiben getrennt", () => {
  const copies = [
    {
      id: 1,
      attachments: [
        { index: 1, name: "a.pdf", contentType: "application/pdf", size: 5000, hash: H_A },
        { index: 2, name: "b.pdf", contentType: "application/pdf", size: 5000, hash: H_B },
      ],
    },
  ];
  assert.equal(collectAttachments(copies).length, 2);
});
