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
import {
  listAttachmentParts,
  listParts,
  setPartFilenames,
  extractPart,
  decodeBody,
} from "./mimeparts.js";
import { sha256Hex, sniffType } from "./attachcontent.js";

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

/**
 * Anhang-Teile einer Nachricht mit MIME-Index (fürs Umbenennen) UND
 * dekodierter Größe (fürs Wiedererkennen desselben Anhangs in einer anderen
 * Kopie). Beide Quellen laufen die MIME-Struktur in derselben Reihenfolge ab,
 * deshalb lassen sie sich der Reihe nach paaren.
 */
export async function mergeParts(messageId) {
  const bytes = await getRawBytes(messageId);
  const raw = listAttachmentParts(bytes);
  const listed = await api.messages.listAttachments(messageId).catch(() => []);
  const parts = raw.map((p, i) => ({
    index: p.index,
    filename: p.filename || listed[i]?.name || "",
    contentType: p.contentType || listed[i]?.contentType || "",
    size: listed[i]?.size ?? p.bodyEnd - p.headerEnd,
    partName: listed[i]?.partName,
  }));
  return { bytes, parts };
}

/**
 * Führt eine Duplikat-Gruppe zu EINER vollständigen Nachricht zusammen.
 * Grundlage sind die Roh-Bytes der gewählten Kopie; geändert werden nur
 * Kopfzeilen (Empfänger) und die Dateinamen in den Anhang-Kopfzeilen.
 * @param {{baseId:number, headers:object, renames:Array, deleteIds:number[],
 *          permanent?:boolean, keepOriginals?:boolean}} plan
 */
export async function mergeGroup(plan) {
  const header = await api.messages.get(plan.baseId);
  const folder = await folderOf(header);
  if (!folder) throw new Error("Ordner der Nachricht nicht ermittelbar.");

  let bytes = await getRawBytes(plan.baseId);
  for (const [name, value] of Object.entries(plan.headers || {})) {
    if (value) bytes = setHeader(bytes, name, value);
  }
  bytes = setPartFilenames(bytes, plan.renames || []);

  const file = new File([bytes], "merged.eml", { type: "message/rfc822" });
  const imported = await api.messages.import(file, folder, {
    new: false,
    read: header.read,
    flagged: header.flagged,
    tags: header.tags || [],
  });

  if (!plan.keepOriginals) {
    const ids = (plan.deleteIds || []).filter((id) => id !== imported.id);
    if (ids.length) await api.messages.delete(ids, Boolean(plan.permanent));
  }
  return { newId: imported.id, folder };
}

/**
 * Alles, was der Leuchttisch von einer Kopie braucht: Kopfdaten, gesäuberter
 * Text und die Anhänge MIT MIME-Index (damit sich einzelne Teile später
 * byte-genau herausschneiden lassen).
 */
export async function loadForLightTable(messageId, { onProgress } = {}) {
  const [header, full] = await Promise.all([
    api.messages.get(messageId),
    api.messages.getFull(messageId),
  ]);
  const bytes = await getRawBytes(messageId);
  const headerText = splitMessage(bytes).headerText;
  const body = collectBody(full);
  const listed = await api.messages.listAttachments(messageId).catch(() => []);

  // Anhänge dekodieren und über ihren INHALT identifizieren. Das ist teurer
  // als Größe ablesen, aber es ist die einzige Aussage, die trägt: gleicher
  // Hash = wirklich dieselbe Datei, egal wie sie heißt oder kodiert ist.
  const parts = listAttachmentParts(bytes);
  const attachments = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (onProgress) onProgress(i + 1, parts.length);
    const extracted = extractPart(bytes, p);
    const data = decodeBody(extracted);
    const sniffed = sniffType(data);
    attachments.push({
      index: p.index,
      name: p.filename || listed[i]?.name || "",
      contentType: sniffed || p.contentType || listed[i]?.contentType || "",
      declaredType: p.contentType || "",
      sniffedType: sniffed,
      size: data.length || listed[i]?.size || 0,
      encoding: p.encoding,
      hash: await sha256Hex(data),
    });
  }

  return {
    id: messageId,
    header,
    bytes,
    subject: getHeader(headerText, "Subject"),
    from: getHeader(headerText, "From"),
    to: getHeader(headerText, "To"),
    cc: getHeader(headerText, "Cc"),
    date: header.date,
    bodyText: body.plain?.trim() ? body.plain : body.html,
    isHtml: !body.plain?.trim() && !!body.html,
    attachments,
  };
}

/**
 * Dekodierte Dateibytes eines Anhangs — für die Vorschau.
 * @returns {{data:Uint8Array, filename:string, contentType:string}}
 */
export function takePartData(loaded, index) {
  const part = listParts(loaded.bytes).find((p) => p.index === index);
  if (!part) throw new Error(`MIME-Teil ${index} nicht gefunden.`);
  const extracted = extractPart(loaded.bytes, part);
  const data = decodeBody(extracted);
  return {
    data,
    filename: extracted.filename || "",
    contentType: sniffType(data) || extracted.contentType || "application/octet-stream",
  };
}

/**
 * Schneidet einen Anhang byte-genau aus seiner Quell-Nachricht.
 * @param {{bytes:Uint8Array}} loaded Ergebnis von loadForLightTable
 */
export function takePart(loaded, index) {
  const part = listParts(loaded.bytes).find((p) => p.index === index);
  if (!part) throw new Error(`MIME-Teil ${index} nicht gefunden.`);
  return extractPart(loaded.bytes, part);
}

/** Legt eine fertig gebaute Nachricht im Ordner ab. */
export async function importAssembled(bytes, folder, props = {}) {
  const file = new File([bytes], "neu.eml", { type: "message/rfc822" });
  return api.messages.import(file, folder, {
    new: false,
    read: true,
    flagged: false,
    tags: [],
    ...props,
  });
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

/**
 * ALLE Kopfdaten eines Ordners, seitenweise nachgeladen.
 * Nur Kopfdaten — kein Body, kein Roh-Abruf: Das hält auch Ordner mit
 * zehntausenden Nachrichten handhabbar.
 * @param {object} folder
 * @param {{onProgress?:(n:number)=>void, max?:number, includeSubfolders?:boolean}} opts
 */
export async function listAllMessages(folder, opts = {}) {
  const { onProgress, max = 100000 } = opts;
  const out = [];
  let page = await api.messages.list(folder);
  for (;;) {
    out.push(...(page.messages || []));
    if (onProgress) onProgress(out.length);
    if (!page.id || out.length >= max) break;
    page = await api.messages.continueList(page.id);
    if (!page || !page.messages?.length) break;
  }
  return out.slice(0, max);
}

/** Löscht Nachrichten in Blöcken (Papierkorb, außer permanent=true). */
export async function deleteMessages(ids, { permanent = false, chunk = 100, onProgress } = {}) {
  let done = 0;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    await api.messages.delete(slice, permanent);
    done += slice.length;
    if (onProgress) onProgress(done, ids.length);
  }
  return done;
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
