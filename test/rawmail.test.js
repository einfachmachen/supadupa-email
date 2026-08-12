import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setHeader,
  getHeader,
  splitMessage,
  stringToBytes,
  decodeLatin1,
  foldHeader,
  unwrapNestedMessage,
} from "../lib/rawmail.js";
import { readFileSync } from "node:fs";
import { listParts, extractPart, decodeBody } from "../lib/mimeparts.js";

const CRLF = "\r\n";
const SAMPLE =
  ["From: Absender <a@x.de>",
   "To: alt@example.de",
   "Subject: =?UTF-8?B?UmVjaG51bmc=?=",
   "Content-Type: text/plain; charset=utf-8",
   "",
   "Hallo,",
   "anbei die Rechnung.",
   ""].join(CRLF);

test("liest Header aus der Roh-Nachricht", () => {
  const { headerText } = splitMessage(stringToBytes(SAMPLE));
  assert.equal(getHeader(headerText, "To"), "alt@example.de");
  assert.equal(getHeader(headerText, "from"), "Absender <a@x.de>");
});

test("ersetzt To und lässt den Körper Byte für Byte unangetastet", () => {
  const bytes = stringToBytes(SAMPLE);
  const out = setHeader(bytes, "To", "Max Mustermann <max@example.de>");
  const text = decodeLatin1(out);
  assert.match(text, /^To: Max Mustermann <max@example\.de>\r$/m);
  assert.ok(!text.includes("alt@example.de"));
  assert.ok(text.endsWith("Hallo,\r\nanbei die Rechnung.\r\n"));
  assert.match(text, /^From: Absender <a@x\.de>\r$/m);
});

test("ergänzt einen fehlenden Header vor der Leerzeile", () => {
  const noTo = SAMPLE.replace("To: alt@example.de" + CRLF, "");
  const out = decodeLatin1(setHeader(stringToBytes(noTo), "To", "a@b.de"));
  assert.match(out, /^To: a@b\.de\r$/m);
  assert.match(out, /Content-Type: text\/plain[^\r]*\r\nTo: a@b\.de\r\n\r\nHallo/);
});

test("gefaltete Header werden korrekt zusammengesetzt", () => {
  const folded =
    "To: eins@x.de," + CRLF + " zwei@x.de," + CRLF + "\tdrei@x.de" + CRLF + CRLF + "Body";
  const { headerText } = splitMessage(stringToBytes(folded));
  assert.equal(getHeader(headerText, "To"), "eins@x.de, zwei@x.de, drei@x.de");
  const out = decodeLatin1(setHeader(stringToBytes(folded), "To", "neu@x.de"));
  assert.equal(out, "To: neu@x.de" + CRLF + CRLF + "Body");
});

test("faltet lange Adresslisten nur an Kommagrenzen", () => {
  const long = Array.from({ length: 8 }, (_, i) => `empfaenger${i}@sehr-lange-domain.de`).join(", ");
  const res = foldHeader("To", long);
  for (const line of res.trimEnd().split("\r\n")) assert.ok(line.length <= 78, line);
  assert.equal(
    res.replace(/\r\n[ \t]+/g, " ").replace(/^To: /, "").trim(),
    long
  );
});

test("kommt auch mit LF-only-Nachrichten klar", () => {
  const lf = "From: a@x.de\nTo: alt@x.de\n\nText\n";
  const out = decodeLatin1(setHeader(stringToBytes(lf), "To", "neu@x.de"));
  assert.equal(out, "From: a@x.de\nTo: neu@x.de\n\nText\n");
});

test("Nicht-ASCII-Bytes im Körper überleben unverändert", () => {
  const bytes = new Uint8Array([
    ...stringToBytes("To: a@x.de\r\n\r\n"),
    0xc3, 0xa4, 0xff, 0x00, 0x41,
  ]);
  const out = setHeader(bytes, "To", "b@x.de");
  assert.deepEqual([...out.slice(-5)], [0xc3, 0xa4, 0xff, 0x00, 0x41]);
});

test("eine als Text verpackte Nachricht wird ausgepackt", () => {
  // Manche Archivierer legen die ganze MIME-Nachricht als Base64-Text in eine
  // neue Nachricht. Ohne Auspacken sieht man nur Trennmarken und Rohtext —
  // HTML-Fassung und Anhänge bleiben unsichtbar.
  const raw = readFileSync(new URL("./fixtures/wrapped-message.eml", import.meta.url));
  const bytes = new Uint8Array(raw);

  const vorher = listParts(bytes);
  assert.equal(vorher.length, 1, "verpackt sieht es aus wie ein einziger Textteil");

  const { bytes: out, unwrapped } = unwrapNestedMessage(bytes);
  assert.ok(unwrapped);
  const head = splitMessage(out).headerText;
  // Die äußeren Kopfzeilen bleiben erhalten — sonst verlöre die Nachricht
  // ihre Identität.
  assert.equal(getHeader(head, "Message-ID"), "<wrapped-1@example.org>");
  assert.match(getHeader(head, "To"), /anna@example\.org/);
  assert.match(getHeader(head, "Content-Type"), /multipart\/alternative/);

  const parts = listParts(out);
  assert.deepEqual(
    parts.map((p) => p.contentType),
    ["multipart/alternative", "text/plain", "text/html"]
  );
  const html = parts.find((p) => p.contentType === "text/html");
  const text = new TextDecoder().decode(decodeBody(extractPart(out, html)));
  assert.match(text, /<h1>Bestellbestätigung<\/h1>/);
});

test("normale Nachrichten werden nicht angetastet", () => {
  const bytes = stringToBytes(
    "Subject: Test\r\nContent-Type: text/plain\r\n\r\nContent-Type: das ist nur Text.\r\n"
  );
  const res = unwrapNestedMessage(bytes);
  assert.equal(res.unwrapped, false);
  assert.equal(res.bytes, bytes);
});
