import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setHeader,
  getHeader,
  splitMessage,
  stringToBytes,
  decodeLatin1,
  foldHeader,
} from "../lib/rawmail.js";

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
