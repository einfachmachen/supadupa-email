// messageStore.js — Brücke zu den Thunderbird-APIs.
//
// WICHTIG / Architektur-Entscheidung:
// Thunderbird bietet keine API, um Kopfzeilen einer bereits gespeicherten
// Nachricht in-place zu ändern. Der einzige unterstützte Weg ist:
//   Roh-Nachricht lesen → Header im Byte-Strom ersetzen → als neue Nachricht
//   in denselben Ordner importieren (messages.import) → Original entsorgen.
// Gelesen/Markiert/Tags werden dabei übernommen; das Original wandert
// standardmäßig in den Papierkorb (nicht endgültig löschen).

import { setHeader, splitMessage, getHeader } from "./rawmail.js";

const api = typeof messenger !== "undefined" ? messenger : browser;

/** Roh-Nachricht als Uint8Array (byte-genau, ohne Zeichensatz-Umweg). */
export async function getRawBytes(messageId) {
  try {
    const file = await api.messages.getRaw(messageId, { data_format: "File" });
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    // Ältere Builds liefern nur einen Binärstring.
    const str = await api.messages.getRaw(messageId);
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
}

/** Ordner einer Nachricht — deckt alte (`folder`) und neue (`folderId`) API ab. */
export async function folderOf(header) {
  if (header?.folder) return header.folder;
  if (header?.folderId && api.folders?.get) return api.folders.get(header.folderId);
  const full = await api.messages.get(header.id);
  return full.folder || (full.folderId ? api.folders.get(full.folderId) : null);
}

/** Header-Wert direkt aus der Roh-Nachricht (unverfälscht, inkl. encoded-words). */
export async function rawHeader(messageId, name) {
  const bytes = await getRawBytes(messageId);
  return getHeader(splitMessage(bytes).headerText, name);
}

/**
 * Schreibt einen oder mehrere Header neu und ersetzt die Nachricht.
 * @param {number} messageId
 * @param {Record<string,string>} headers z. B. { To: 'Max <a@b>' }
 * @param {{permanent?:boolean}} opts
 * @returns {Promise<{newId:number, folder:object}>}
 */
export async function rewriteHeaders(messageId, headers, opts = {}) {
  const header = await api.messages.get(messageId);
  const folder = await folderOf(header);
  if (!folder) throw new Error("Ordner der Nachricht nicht ermittelbar.");

  let bytes = await getRawBytes(messageId);
  for (const [name, value] of Object.entries(headers)) {
    bytes = setHeader(bytes, name, value);
  }

  const file = new File([bytes], "message.eml", { type: "message/rfc822" });
  const imported = await api.messages.import(file, folder, {
    new: false,
    read: header.read,
    flagged: header.flagged,
    tags: header.tags || [],
  });

  await api.messages.delete([messageId], Boolean(opts.permanent));
  return { newId: imported.id, folder };
}

/** Voller Nachrichteninhalt inkl. Textkörper und Anhang-Liste. */
export async function loadMessage(messageId) {
  const [header, full, parts] = await Promise.all([
    api.messages.get(messageId),
    api.messages.getFull(messageId),
    api.messages.listAttachments(messageId).catch(() => []),
  ]);
  return {
    id: messageId,
    header,
    full,
    body: collectBody(full),
    attachments: (parts || []).map((a) => ({
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      partName: a.partName,
    })),
  };
}

/** Textkörper aus der MIME-Struktur ziehen (text/plain bevorzugt). */
export function collectBody(part, acc = { plain: "", html: "" }) {
  if (!part) return acc;
  const type = (part.contentType || "").toLowerCase();
  if (part.body && type.startsWith("text/")) {
    if (type.includes("html")) acc.html += part.body;
    else acc.plain += part.body;
  }
  for (const p of part.parts || []) collectBody(p, acc);
  return acc;
}

/** Alle Ordner aller Konten, flach, mit lesbarem Pfad. */
export async function listFolders() {
  const accounts = await api.accounts.list();
  const out = [];
  const walk = (folders, accName) => {
    for (const f of folders || []) {
      out.push({ id: f.id, path: `${accName}${f.path}`, folder: f });
      walk(f.subFolders, accName);
    }
  };
  for (const acc of accounts) {
    const folders = acc.folders || (await api.folders.query({ accountId: acc.id }).catch(() => []));
    walk(folders, acc.name + " · ");
  }
  return out;
}

/** Nachrichten eines Ordners (erste Seite, ausreichend zum Vergleichen). */
export async function listMessages(folder, limit = 50) {
  const page = await api.messages.list(folder);
  return (page.messages || []).slice(0, limit);
}

/** Adressbuch-Kontakte als {name, email}-Paare. */
export async function contactPairs() {
  const pairs = [];
  const books = await api.addressBooks.list(true).catch(() => []);
  for (const book of books) {
    for (const c of book.contacts || []) {
      const props = c.properties || {};
      const name =
        props.DisplayName ||
        [props.FirstName, props.LastName].filter(Boolean).join(" ").trim();
      for (const key of ["PrimaryEmail", "SecondEmail"]) {
        if (props[key]) pairs.push({ name, email: props[key] });
      }
    }
  }
  return pairs;
}

export const messengerApi = api;
