// attachcontent.js — Anhänge über ihren INHALT identifizieren.
//
// Bisher wurden gleiche Anhänge an Größe + MIME-Typ erkannt. Das reicht nicht:
// Zwei verschiedene PDFs können zufällig gleich groß sein, und derselbe
// Anhang kann in einer Kopie anders kodiert sein (base64 vs.
// quoted-printable) und damit eine andere „Größe" melden. Maßgeblich ist der
// SHA-256 über die DEKODIERTEN Dateibytes — zwei Anhänge sind genau dann
// derselbe, wenn ihr Inhalt Byte für Byte gleich ist.

const HEX = "0123456789abcdef";

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** SHA-256 über die Dateibytes, als Hex. Leere Daten → "". */
export async function sha256Hex(bytes) {
  if (!bytes || !bytes.length) return "";
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(bytes);
  try {
    // Eigene Kopie: Manche Aufrufer geben eine Sicht auf einen größeren
    // Puffer weiter — digest würde dann über den GANZEN Puffer laufen.
    const copy = bytes.slice();
    return toHex(await subtle.digest("SHA-256", copy));
  } catch {
    return fallbackHash(bytes);
  }
}

/** Notnagel ohne Web Crypto (FNV-1a, 64 Bit über zwei Läufe). */
function fallbackHash(bytes) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[bytes.length - 1 - i], 0x85ebca6b) >>> 0;
  }
  return `fnv${a.toString(16)}${b.toString(16)}`;
}

/**
 * Schlüssel, unter dem ein Anhang mit seinen Geschwistern zusammenfällt.
 * Inhalts-Hash schlägt alles; ohne ihn bleibt der alte Notbehelf.
 */
export function attachmentKey({ hash, size, contentType }) {
  if (hash) return `sha:${hash}`;
  return `meta:${size || 0}|${(contentType || "").toLowerCase()}`;
}

/**
 * Unterhalb dieser Größe kann kein sinnvoller Inhalt drinstecken: 0-Byte-
 * Reste, 2-Byte-Fragmente, 43-Byte-Zählpixel. Solche Teile werden in der
 * Anhangsliste eingeklappt und nicht vorausgewählt — aber NICHT gelöscht und
 * nicht verschwiegen (ein Klick zeigt sie).
 */
export const TINY_LIMIT = 100;

/** Ist das Teil zu klein, um Inhalt zu tragen? */
export function isTinyAttachment(size) {
  return Number(size || 0) < TINY_LIMIT;
}

/** Kurzform des Hashes für die Anzeige. */
export function shortHash(hash) {
  if (!hash) return "";
  return hash.startsWith("fnv") ? hash.slice(0, 11) : hash.slice(0, 10);
}

/**
 * MIME-Typ aus den ersten Bytes ableiten — nützlich, wenn die Kopfzeile
 * `application/octet-stream` behauptet, in Wahrheit aber ein PDF drinsteckt.
 * @returns {string} erkannter Typ oder ""
 */
export function sniffType(bytes) {
  if (!bytes || bytes.length < 4) return "";
  const b = bytes;
  const starts = (...sig) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "application/zip"; // auch docx/xlsx
  if (starts(0x25, 0x21, 0x50, 0x53)) return "application/postscript";
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return "application/msword"; // altes Office
  return "";
}

/** Kann die Vorschau das darstellen? */
export function previewKind(contentType, name = "") {
  const t = String(contentType || "").toLowerCase();
  const ext = String(name).toLowerCase().split(".").pop();
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("text/") || ["txt", "csv", "xml", "json", "md", "log"].includes(ext)) {
    return "text";
  }
  return "none";
}
