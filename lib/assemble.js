// assemble.js — aus ausgewählten Einzelbestandteilen eine neue, vollständige
// Nachricht bauen (RFC 5322 / MIME multipart/mixed).
//
// Anders als merge.js, das eine Kopie als Grundlage nimmt: Hier kommt JEDER
// Bestandteil aus einer frei gewählten Quelle — Betreff aus Kopie A, Empfänger
// aus B, Text aus C, Anhang 1 aus A, Anhang 2 aus D. Anhänge werden als
// unveränderte Blöcke (Kopfzeilen + kodierte Nutzlast) übernommen, nur der
// Dateiname darf neu sein. Es wird nichts neu kodiert.

import { encodeLatin1, decodeLatin1 } from "./rawmail.js";
import { retitlePart } from "./mimeparts.js";
import { formatAddressList, parseAddressList } from "./mime.js";

const EOL = "\r\n";

function b64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

/** Zufällige, kollisionssichere Grenze. */
export function makeBoundary(seed = "") {
  const rnd = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `----supadupa_${seed}${rnd}`.slice(0, 68);
}

/** Message-ID für die neu gebaute Nachricht. */
export function makeMessageId(domain = "supadupa.local") {
  const rnd = Math.random().toString(36).slice(2);
  return `<${Date.now().toString(36)}.${rnd}@${domain}>`;
}

/** Text als Quoted-Printable kodieren (UTF-8), zeilenweise ≤ 76 Zeichen. */
export function toQuotedPrintable(text) {
  const bytes = new TextEncoder().encode(String(text).replace(/\r?\n/g, "\r\n"));
  let out = "";
  let lineLen = 0;
  const push = (chunk) => {
    if (lineLen + chunk.length > 75) {
      out += `=${EOL}`;
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      out += EOL;
      lineLen = 0;
      i++;
      continue;
    }
    if (b === 0x3d || b < 0x20 || b > 0x7e) {
      push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    } else if ((b === 0x20 || b === 0x09) && (bytes[i + 1] === 0x0d || i === bytes.length - 1)) {
      push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    } else {
      push(String.fromCharCode(b));
    }
  }
  return out;
}

function headerLine(name, value) {
  return `${name}: ${value}${EOL}`;
}

function encodeSubject(subject) {
  const s = String(subject || "");
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(s)) return s;
  return `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`;
}

function normList(value) {
  const list = parseAddressList(value || "");
  return list.length ? formatAddressList(list) : "";
}

/**
 * Baut die neue Nachricht.
 * @param {{
 *   headers: {from?:string, to?:string, cc?:string, subject?:string,
 *             date?:string|Date, messageId?:string, extra?:object},
 *   bodyText: string,                    // Klartext (wird als UTF-8/QP gesetzt)
 *   bodyPart?: {headerText:string, body:Uint8Array}, // alternativ: Original-Teil
 *   attachments?: Array<{headerText:string, body:Uint8Array, filename?:string,
 *                        contentTypeRaw?:string, dispositionRaw?:string,
 *                        encoding?:string, contentType?:string}>
 * }} spec
 * @returns {Uint8Array}
 */
export function assembleMessage(spec) {
  const h = spec.headers || {};
  // Achtung: `a.filename` trägt bereits den GEWÜNSCHTEN Namen, `filenameOriginal`
  // den aus der Quelle. retitlePart muss den Original-Stand sehen, sonst hält es
  // die Umbenennung für erledigt und lässt die Kopfzeilen unverändert.
  const atts = (spec.attachments || []).map((a) => {
    const original = a.filenameOriginal ?? a.filename;
    return a.filename && a.filename !== original
      ? retitlePart({ ...a, filename: original }, a.filename)
      : a;
  });

  const date = h.date ? new Date(h.date) : new Date();
  const head = [];
  if (h.from) head.push(headerLine("From", normList(h.from) || h.from));
  if (h.to) head.push(headerLine("To", normList(h.to) || h.to));
  if (h.cc) head.push(headerLine("Cc", normList(h.cc) || h.cc));
  head.push(headerLine("Subject", encodeSubject(h.subject)));
  head.push(headerLine("Date", Number.isNaN(date.valueOf()) ? new Date().toUTCString() : date.toUTCString()));
  head.push(headerLine("Message-ID", h.messageId || makeMessageId()));
  for (const [k, v] of Object.entries(h.extra || {})) if (v) head.push(headerLine(k, v));
  head.push(headerLine("MIME-Version", "1.0"));

  const bodyChunks = [];
  const textPart = spec.bodyPart
    ? { headerText: spec.bodyPart.headerText, body: spec.bodyPart.body }
    : {
        headerText:
          `Content-Type: text/plain; charset=utf-8${EOL}` +
          `Content-Transfer-Encoding: quoted-printable${EOL}${EOL}`,
        body: encodeLatin1(toQuotedPrintable(spec.bodyText || "")),
      };

  if (!atts.length) {
    head.push(textPart.headerText.replace(/(\r?\n)+$/, EOL));
    return concat(encodeLatin1(head.join("") + EOL), textPart.body);
  }

  const boundary = makeBoundary();
  head.push(headerLine("Content-Type", `multipart/mixed; boundary="${boundary}"`));

  bodyChunks.push(encodeLatin1(`${EOL}--${boundary}${EOL}`));
  bodyChunks.push(encodeLatin1(ensureBlankLine(textPart.headerText)));
  bodyChunks.push(textPart.body);
  for (const a of atts) {
    bodyChunks.push(encodeLatin1(`${EOL}--${boundary}${EOL}`));
    bodyChunks.push(encodeLatin1(ensureBlankLine(a.headerText)));
    bodyChunks.push(a.body);
  }
  bodyChunks.push(encodeLatin1(`${EOL}--${boundary}--${EOL}`));

  return concat(encodeLatin1(head.join("")), ...bodyChunks);
}

function ensureBlankLine(headerText) {
  const t = String(headerText).replace(/(\r?\n)+$/, "");
  return t + EOL + EOL;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

export { concat, decodeLatin1 };
