// rawmail.js — Arbeiten auf der Roh-Nachricht (RFC 5322).
//
// Wichtig: Der Nachrichten-Körper wird NIE angefasst. Wir schneiden nur den
// Header-Block heraus, schreiben dort eine Zeile um und setzen die Bytes
// unverändert wieder zusammen. Alles andere (Kodierung, Anhänge, Signaturen)
// bleibt Byte für Byte identisch.

const LATIN1 = "latin1"; // 1 Byte = 1 Zeichen, verlustfreier Round-Trip

function decodeLatin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function encodeLatin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** Findet das Ende des Header-Blocks (Index nach der Leerzeile). */
export function findHeaderEnd(bytes) {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return i + 2; // \n\n
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return i + 4; // \r\n\r\n
    }
  }
  return bytes.length;
}

/** Roh-Bytes → { headerText, headerEnd } */
export function splitMessage(bytes) {
  const headerEnd = findHeaderEnd(bytes);
  return { headerText: decodeLatin1(bytes.subarray(0, headerEnd)), headerEnd };
}

/**
 * Faltet Header-Zeilen zusammen und liefert [{name, value, start, end}]
 * mit Indizes in den Header-Text (inkl. Zeilenumbruch am Ende).
 */
export function parseHeaderBlock(headerText) {
  const lines = headerText.split(/(?<=\n)/); // Umbrüche bleiben erhalten
  const fields = [];
  let pos = 0;
  for (const line of lines) {
    const isCont = /^[ \t]/.test(line);
    if (isCont && fields.length) {
      fields[fields.length - 1].raw += line;
      fields[fields.length - 1].end = pos + line.length;
    } else {
      const m = line.match(/^([!-9;-~]+):/);
      if (m) {
        fields.push({
          name: m[1],
          raw: line,
          start: pos,
          end: pos + line.length,
        });
      }
    }
    pos += line.length;
  }
  return fields.map((f) => ({
    name: f.name,
    value: unfold(f.raw.slice(f.name.length + 1)),
    start: f.start,
    end: f.end,
  }));
}

function unfold(v) {
  return v.replace(/\r?\n[ \t]+/g, " ").replace(/\r?\n$/, "").trim();
}

/** Header-Wert lesen (erster Treffer, case-insensitiv). */
export function getHeader(headerText, name) {
  const want = name.toLowerCase();
  const f = parseHeaderBlock(headerText).find(
    (x) => x.name.toLowerCase() === want
  );
  return f ? f.value : "";
}

/**
 * Faltet einen langen Header-Wert an Kommas auf ~76 Zeichen — encoded-words
 * werden dabei nie zerschnitten, weil nur an Kommagrenzen umgebrochen wird.
 */
export function foldHeader(name, value, eol = "\r\n") {
  const parts = String(value).split(/,\s*/);
  let line = `${name}:`;
  const out = [];
  parts.forEach((p, i) => {
    const piece = ` ${p}${i < parts.length - 1 ? "," : ""}`;
    if (line.length + piece.length > 76 && line !== `${name}:`) {
      out.push(line);
      line = " " + piece.trimStart();
    } else {
      line += piece;
    }
  });
  out.push(line);
  return out.join(eol) + eol;
}

/**
 * Ersetzt (oder ergänzt) ein Header-Feld im Roh-Byte-Array.
 * Gibt neue Bytes zurück; das Original bleibt unverändert.
 */
export function setHeader(bytes, name, value) {
  const { headerText, headerEnd } = splitMessage(bytes);
  const eol = headerText.includes("\r\n") ? "\r\n" : "\n";
  const fields = parseHeaderBlock(headerText);
  const want = name.toLowerCase();
  const target = fields.find((f) => f.name.toLowerCase() === want);
  const replacement = foldHeader(name, value, eol);

  let newHeader;
  if (target) {
    newHeader =
      headerText.slice(0, target.start) +
      replacement +
      headerText.slice(target.end);
  } else {
    // vor die abschließende Leerzeile setzen
    const blank = headerText.length - eol.length;
    newHeader = headerText.slice(0, blank) + replacement + headerText.slice(blank);
  }

  const head = encodeLatin1(newHeader);
  const out = new Uint8Array(head.length + bytes.length - headerEnd);
  out.set(head, 0);
  out.set(bytes.subarray(headerEnd), head.length);
  return out;
}

/** Bequemer Zugriff, wenn nur ein String vorliegt. */
export function stringToBytes(str) {
  return encodeLatin1(str);
}
export { decodeLatin1, encodeLatin1, LATIN1 };

// ---------------------------------------------------------------------------
// Verpackte Nachrichten wieder auspacken
//
// Manche Archivierungs- und Konvertierungswerkzeuge legen eine vollständige
// MIME-Nachricht als *Inhalt* in eine neue Nachricht: außen steht dann
// `Content-Type: text/plain` mit Base64, und erst der dekodierte Rumpf beginnt
// mit `Content-type: multipart/alternative; boundary=…`. Ohne Auspacken sieht
// man nur den Rohtext samt Trennmarken — die HTML-Fassung und die Anhänge
// bleiben unsichtbar, obwohl sie da sind.

/** Sieht der Rumpf aus wie der Anfang einer eigenen Nachricht? */
function looksLikeNestedMessage(text) {
  const head = String(text || "").slice(0, 2000);
  if (!/^\s*content-type\s*:/i.test(head)) return false;
  // Ein bloßes „Content-Type: text/plain“ als erste Zeile reicht nicht — es
  // muss eine mehrteilige Struktur mit Trennmarke sein, sonst packen wir
  // harmlosen Text auseinander.
  return /^\s*content-type\s*:[^\n]*multipart\/[a-z]+/is.test(head) && /boundary\s*=/i.test(head);
}

/** Base64/Quoted-Printable eines Rumpfes auflösen (byte-genau, Latin-1). */
function decodeTransfer(body, encoding) {
  const enc = String(encoding || "").trim().toLowerCase();
  if (enc === "base64") {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, "");
    if (typeof atob === "function") return atob(clean);
    return Buffer.from(clean, "base64").toString("binary");
  }
  if (enc === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/**
 * Packt eine so verpackte Nachricht aus.
 * Die äußeren Kopfzeilen (Datum, Betreff, Absender, Empfänger) bleiben
 * erhalten — nur die Inhalts-Kopfzeilen kommen aus der inneren Nachricht.
 * Passt nichts, wird die Eingabe unverändert zurückgegeben.
 *
 * @param {Uint8Array} bytes Roh-Nachricht
 * @returns {{bytes:Uint8Array, unwrapped:boolean}}
 */
export function unwrapNestedMessage(bytes) {
  const { headerText, headerEnd } = splitMessage(bytes);
  const outerType = getHeader(headerText, "Content-Type") || "";
  // Nur wenn außen KEINE mehrteilige Struktur steht — sonst ist alles in
  // Ordnung und es gibt nichts auszupacken.
  if (/multipart\//i.test(outerType)) return { bytes, unwrapped: false };

  const body = decodeLatin1(bytes.subarray(headerEnd));
  const inner = decodeTransfer(body, getHeader(headerText, "Content-Transfer-Encoding"));
  if (!looksLikeNestedMessage(inner)) return { bytes, unwrapped: false };

  const innerBytes = stringToBytes(inner);
  const split = splitMessage(innerBytes);
  const innerHeaders = split.headerText;
  const innerBody = decodeLatin1(innerBytes.subarray(split.headerEnd));

  // Äußere Kopfzeilen ohne die Inhalts-Angaben, dann die inneren Inhalts-
  // Angaben, dann der innere Rumpf. So bleibt die Nachricht identifizierbar
  // (Message-ID, Datum) und wird trotzdem richtig gelesen.
  const kept = parseHeaderBlock(headerText)
    .filter((f) => !/^content-(type|transfer-encoding|disposition|id|description)$/i.test(f.name))
    .map((f) => headerText.slice(f.start, f.end))
    .join("");
  const rebuilt = `${kept}${innerHeaders}${innerBody}`;
  return { bytes: stringToBytes(rebuilt), unwrapped: true };
}
