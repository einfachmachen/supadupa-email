// mimeparts.js — MIME-Struktur auf Byte-Ebene begehen und Teil-Kopfzeilen
// ändern, ohne die Nutzdaten anzufassen.
//
// Alle Arbeit passiert in einer Latin-1-Zeichenkette: 1 Byte = 1 Zeichen,
// verlustfreier Round-Trip auch für 8-Bit-Binärinhalte. Offsets sind damit
// Byte-Offsets. Base64/Quoted-Printable-Nutzlast wird nie berührt — nur die
// Kopfzeilen einzelner MIME-Teile.

import { decodeLatin1, encodeLatin1 } from "./rawmail.js";
import { decodeHeaderValue } from "./mime.js";

/** Wert eines Parameters aus einem Header (charset=…, boundary=…, name=…). */
export function getParam(headerValue, param) {
  const v = String(headerValue || "");
  // RFC 2231: name*=UTF-8''… hat Vorrang vor name="…"
  const ext = new RegExp(`${param}\\*\\s*=\\s*([^;]+)`, "i").exec(v);
  if (ext) return decodeRfc2231(ext[1].trim());
  const quoted = new RegExp(`${param}\\s*=\\s*"([^"]*)"`, "i").exec(v);
  if (quoted) return decodeHeaderValue(quoted[1]);
  const bare = new RegExp(`${param}\\s*=\\s*([^;\\s]+)`, "i").exec(v);
  return bare ? decodeHeaderValue(bare[1]) : "";
}

function decodeRfc2231(raw) {
  const m = /^([^']*)'([^']*)'(.*)$/.exec(raw.replace(/^"|"$/g, ""));
  const [charset, text] = m ? [m[1] || "utf-8", m[3]] : ["utf-8", raw];
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && /^[0-9a-fA-F]{2}$/.test(text.substr(i + 1, 2))) {
      bytes.push(parseInt(text.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder(charset.toLowerCase()).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

/** Dateiname als Parameter kodieren — ASCII schlicht, sonst RFC 2231. */
export function encodeFilenameParams(name, { forContentType = false } = {}) {
  const key = forContentType ? "name" : "filename";
  const n = String(name || "");
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(n)) return `${key}="${n.replace(/(["\\])/g, "\\$1")}"`;
  const ascii = n
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, "_");
  const pct = [...new TextEncoder().encode(n)]
    .map((b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || "-_.".includes(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
    )
    .join("");
  return `${key}="${ascii}"; ${key}*=UTF-8''${pct}`;
}

function headerEndIn(s, from) {
  const a = s.indexOf("\r\n\r\n", from);
  const b = s.indexOf("\n\n", from);
  if (a >= 0 && (b < 0 || a <= b)) return a + 4;
  if (b >= 0) return b + 2;
  return s.length;
}

function fieldValue(headerText, name) {
  const re = new RegExp(`^${name}:([^\\n]*(?:\\n[ \\t][^\\n]*)*)`, "im");
  const m = re.exec(headerText);
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

/**
 * Begeht die MIME-Struktur und liefert alle Teile mit Byte-Offsets.
 * @param {Uint8Array} bytes
 * @returns {Array<{index:number, depth:number, contentType:string,
 *   filename:string, disposition:string, encoding:string,
 *   headerStart:number, headerEnd:number, bodyEnd:number, isAttachment:boolean}>}
 */
export function listParts(bytes) {
  const s = decodeLatin1(bytes);
  const parts = [];
  let index = 0;

  const walk = (start, end, depth) => {
    const hEnd = Math.min(headerEndIn(s, start), end);
    const headerText = s.slice(start, hEnd);
    const ctype = fieldValue(headerText, "Content-Type");
    const disp = fieldValue(headerText, "Content-Disposition");
    const enc = fieldValue(headerText, "Content-Transfer-Encoding");
    const cid = fieldValue(headerText, "Content-ID").replace(/^<|>$/g, "").trim();
    const mime = (ctype.split(";")[0] || "text/plain").trim().toLowerCase();
    const filename = getParam(disp, "filename") || getParam(ctype, "name");

    parts.push({
      index: index++,
      depth,
      contentType: mime,
      contentTypeRaw: ctype,
      dispositionRaw: disp,
      encoding: enc.toLowerCase(),
      contentId: cid,
      filename,
      headerStart: start,
      headerEnd: hEnd,
      bodyEnd: end,
      // Ein Bild, das per cid: im HTML eingebunden ist, gehört zum Text —
      // nicht in die Anhangsliste, sonst taucht jede Signatur-Grafik dort auf.
      isAttachment:
        !cid &&
        (/^attachment/i.test(disp) ||
          (!!filename && !/^inline/i.test(disp)) ||
          (!!filename && !mime.startsWith("text/"))),
      isInlineImage: !!cid && mime.startsWith("image/"),
    });

    if (!mime.startsWith("multipart/")) return;
    const boundary = getParam(ctype, "boundary");
    if (!boundary) return;

    const marker = `--${boundary}`;
    const positions = [];
    let at = s.indexOf(marker, hEnd);
    while (at >= 0 && at < end) {
      const lineStart = at === 0 || s[at - 1] === "\n";
      if (lineStart) positions.push(at);
      if (s.startsWith(`${marker}--`, at)) break;
      at = s.indexOf(marker, at + marker.length);
    }
    for (let i = 0; i < positions.length - 1; i++) {
      const from = s.indexOf("\n", positions[i]) + 1;
      let to = positions[i + 1];
      // abschließenden Zeilenumbruch vor der nächsten Grenze abschneiden
      if (s[to - 1] === "\n") to--;
      if (s[to - 1] === "\r") to--;
      if (from > 0 && to > from) walk(from, to, depth + 1);
    }
  };

  walk(0, s.length, 0);
  return parts;
}

/** Nur die Teile, die als Anhang zählen. */
export function listAttachmentParts(bytes) {
  return listParts(bytes).filter((p) => p.isAttachment);
}

/**
 * Setzt die Dateinamen mehrerer MIME-Teile neu.
 * @param {Uint8Array} bytes
 * @param {Array<{index:number, filename:string}>} renames
 * @returns {Uint8Array}
 */
export function setPartFilenames(bytes, renames) {
  if (!renames?.length) return bytes;
  const parts = listParts(bytes);
  let s = decodeLatin1(bytes);

  // Von hinten nach vorn ersetzen, damit frühere Offsets gültig bleiben.
  const jobs = renames
    .map((r) => ({ part: parts.find((p) => p.index === r.index), name: r.filename }))
    .filter((j) => j.part && j.name)
    .sort((a, b) => b.part.headerStart - a.part.headerStart);

  for (const { part, name } of jobs) {
    const head = s.slice(part.headerStart, part.headerEnd);
    let out = head;

    const dispRe = /^(Content-Disposition:)([^\n]*(?:\n[ \t][^\n]*)*)/im;
    if (dispRe.test(out)) {
      out = out.replace(dispRe, (_m, key, val) => {
        const kind = (val.split(";")[0] || " attachment").trim() || "attachment";
        return `${key} ${kind}; ${encodeFilenameParams(name)}`;
      });
    } else {
      const eol = out.includes("\r\n") ? "\r\n" : "\n";
      const at = out.length - (out.endsWith(eol + eol) ? eol.length : 0);
      out =
        out.slice(0, at) +
        `Content-Disposition: attachment; ${encodeFilenameParams(name)}${eol}` +
        out.slice(at);
    }

    const ctRe = /^(Content-Type:)([^\n]*(?:\n[ \t][^\n]*)*)/im;
    out = out.replace(ctRe, (_m, key, val) => {
      const flat = val.replace(/\r?\n[ \t]+/g, " ");
      const cleaned = flat
        .split(";")
        .filter((seg) => !/^\s*name\s*\*?\s*=/i.test(seg))
        .join(";")
        .trimEnd();
      return `${key}${cleaned}; ${encodeFilenameParams(name, { forContentType: true })}`;
    });

    s = s.slice(0, part.headerStart) + out + s.slice(part.headerEnd);
  }
  return encodeLatin1(s);
}

/**
 * Schneidet einen MIME-Teil als eigenständigen Block heraus.
 * Kopfzeilen und Nutzlast bleiben exakt, wie sie in der Quell-Nachricht
 * stehen — deshalb lässt sich der Block unverändert in eine neue Nachricht
 * einsetzen, ohne die Kodierung anzufassen.
 * @returns {{headerText:string, body:Uint8Array, contentType:string,
 *            encoding:string, filename:string}}
 */
export function extractPart(bytes, part) {
  const s = decodeLatin1(bytes);
  return {
    headerText: s.slice(part.headerStart, part.headerEnd),
    body: bytes.slice(part.headerEnd, part.bodyEnd),
    contentType: part.contentType,
    contentTypeRaw: part.contentTypeRaw,
    dispositionRaw: part.dispositionRaw,
    encoding: part.encoding,
    filename: part.filename,
  };
}

/**
 * Dekodiert die Nutzlast eines Teils (base64 / quoted-printable / roh).
 * Ergebnis sind die ECHTEN Dateibytes — Grundlage für Inhalts-Vergleich und
 * Vorschau. Die Nachricht selbst bleibt unangetastet.
 * @returns {Uint8Array}
 */
export function decodeBody(extracted) {
  const enc = String(extracted?.encoding || "").toLowerCase().trim();
  const body = extracted?.body || new Uint8Array();
  if (enc === "base64") return fromBase64(decodeLatin1(body));
  if (enc === "quoted-printable") return fromQuotedPrintable(decodeLatin1(body));
  return body;
}

function fromBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const bin = typeof atob === "function"
      ? atob(clean)
      : Buffer.from(clean, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

function fromQuotedPrintable(text) {
  const joined = text.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === "=" && /^[0-9a-fA-F]{2}$/.test(joined.substr(i + 1, 2))) {
      out.push(parseInt(joined.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Kopfzeilen eines herausgeschnittenen Teils mit neuem Dateinamen. */
export function retitlePart(extracted, filename) {
  if (!filename || filename === extracted.filename) return extracted;
  const eol = extracted.headerText.includes("\r\n") ? "\r\n" : "\n";
  const lines = [];
  const ct = (extracted.contentTypeRaw || extracted.contentType || "application/octet-stream")
    .split(";")
    .filter((seg) => !/^\s*name\s*\*?\s*=/i.test(seg))
    .join(";")
    .trim();
  lines.push(`Content-Type: ${ct}; ${encodeFilenameParams(filename, { forContentType: true })}`);
  if (extracted.encoding) lines.push(`Content-Transfer-Encoding: ${extracted.encoding}`);
  const kind = (extracted.dispositionRaw || "attachment").split(";")[0].trim() || "attachment";
  lines.push(`Content-Disposition: ${kind}; ${encodeFilenameParams(filename)}`);
  return { ...extracted, filename, headerText: lines.join(eol) + eol + eol };
}

/** Roh-Bytes des Nachrichtenkörpers (alles nach dem Haupt-Header). */
export function bodyBytes(bytes) {
  const s = decodeLatin1(bytes);
  return bytes.subarray(headerEndIn(s, 0));
}
