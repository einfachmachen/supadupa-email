// mime.js — Header-Kodierung/-Dekodierung nach RFC 2047 / RFC 5322.
// Reines JS ohne Browser- oder Thunderbird-APIs, damit es testbar bleibt.

const SPECIALS = /[()<>@,;:\\".\[\]]/;

/** Base64 <-> Bytes, ohne Node/Browser-Unterschiede. */
function b64ToBytes(s) {
  const bin = atobSafe(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoaSafe(bin);
}
function atobSafe(s) {
  if (typeof atob === "function") return atob(s);
  return Buffer.from(s, "base64").toString("binary");
}
function btoaSafe(s) {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "binary").toString("base64");
}

function decodeCharset(bytes, charset) {
  const cs = (charset || "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Dekodiert einen Header-Wert mit encoded-words (=?UTF-8?B?…?=).
 * Angrenzende encoded-words werden ohne den trennenden Whitespace verbunden,
 * so wie RFC 2047 es verlangt — sonst zerfallen umlaut-getrennte Namen.
 */
export function decodeHeaderValue(value) {
  if (!value) return "";
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  let m;
  while ((m = re.exec(value)) !== null) {
    const between = value.slice(last, m.index);
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    const [, charset, enc, text] = m;
    let bytes;
    if (enc.toLowerCase() === "b") {
      bytes = b64ToBytes(text);
    } else {
      const chars = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "_") chars.push(0x20);
        else if (c === "=" && /^[0-9a-fA-F]{2}$/.test(text.substr(i + 1, 2))) {
          chars.push(parseInt(text.substr(i + 1, 2), 16));
          i += 2;
        } else chars.push(c.charCodeAt(0) & 0xff);
      }
      bytes = new Uint8Array(chars);
    }
    out += decodeCharset(bytes, charset);
    last = re.lastIndex;
    prevWasWord = true;
  }
  out += value.slice(last);
  return out;
}

/** Kodiert einen Anzeigenamen als encoded-word, falls nötig. */
export function encodeDisplayName(name) {
  const n = (name || "").trim();
  if (!n) return "";
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(n)) {
    return SPECIALS.test(n) ? `"${n.replace(/([\\"])/g, "\\$1")}"` : n;
  }
  const bytes = new TextEncoder().encode(n);
  return `=?UTF-8?B?${bytesToB64(bytes)}?=`;
}

/** {name, email} → "Name <adresse>" bzw. nur "adresse". */
export function formatAddress({ name, email }) {
  const addr = (email || "").trim();
  const enc = encodeDisplayName(name);
  if (!enc) return addr;
  if (!addr) return enc;
  return `${enc} <${addr}>`;
}

/** Anzeigename in lesbarer Form (Anführungszeichen/Escapes entfernt). */
function unquote(s) {
  const t = (s || "").trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return t;
}

/**
 * Zerlegt eine einzelne Adresse in {name, email}.
 * Erkennt "Name <a@b>", "<a@b>", "a@b", "a@b (Name)".
 */
export function parseAddress(raw) {
  const s = decodeHeaderValue(String(raw || "")).trim();
  if (!s) return { name: "", email: "" };
  const angle = s.match(/^(.*)<([^<>]*)>\s*$/);
  if (angle) {
    return { name: unquote(angle[1]), email: angle[2].trim() };
  }
  const comment = s.match(/^(\S+@\S+)\s*\((.*)\)\s*$/);
  if (comment) return { name: unquote(comment[2]), email: comment[1] };
  if (s.includes("@")) return { name: "", email: s };
  return { name: unquote(s), email: "" };
}

/**
 * Zerlegt eine Adressliste an Kommas — respektiert Anführungszeichen und
 * spitze Klammern, damit '"Nachname, Vorname" <a@b>' eine Adresse bleibt.
 */
export function splitAddressList(value) {
  const s = String(value || "");
  const parts = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && inQuote) {
      cur += c + (s[i + 1] || "");
      i++;
      continue;
    }
    if (c === '"') inQuote = !inQuote;
    else if (c === "<" && !inQuote) inAngle = true;
    else if (c === ">" && !inQuote) inAngle = false;
    if (c === "," && !inQuote && !inAngle) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Adressliste → [{name, email}] */
export function parseAddressList(value) {
  return splitAddressList(value).map(parseAddress);
}

/** [{name,email}] → Header-Wert */
export function formatAddressList(list) {
  return (list || []).map(formatAddress).filter(Boolean).join(", ");
}

const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>".]+\.[^\s@,<>"]+$/;

/** Grobe Syntaxprüfung einer Adresse (bewusst tolerant). */
export function isPlausibleEmail(email) {
  return EMAIL_RE.test(String(email || "").trim());
}
