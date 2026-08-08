// rebuild.js — aus geladenen Kopien eine neue Nachricht bauen.
//
// Denselben Weg gehen zwei Aufrufer: der Leuchttisch (mit den dort getroffenen
// Entscheidungen) und die Stapelverarbeitung am Ende des Durchgangs (mit der
// Vorauswahl). Nur so ist sicher, dass „im Stapel" dasselbe herauskommt wie
// „von Hand bestätigt".
//
// Bewusst frei von Thunderbird-APIs: Eingabe sind bereits geladene Kopien.

import { collectCandidates, pickDefaults } from "./candidates.js";
import { buildImagePool, inlineSetForRebuild, dataUrlToBytes } from "./inlineparts.js";
import { buildReaderDocument, looksLikeHtml } from "./htmlmail.js";
import { clean } from "./textclean.js";
import { assembleMessage } from "./assemble.js";
import { listParts, extractPart } from "./mimeparts.js";

/** Die Kopie, die den Rumpf stellt: die mit HTML, sonst die erste. */
export function pickBodySource(copies) {
  return copies.find((c) => c.html || looksLikeHtml(c.bodyText)) || copies[0];
}

/**
 * Baut die neue Nachricht.
 * @param {Array} copies Ergebnisse von loadForLightTable (inkl. `inline`)
 * @param {{profiles?:Array, selection?:object, keepHtml?:boolean, note?:string}} opts
 *        `selection` überschreibt die Vorauswahl (der Leuchttisch reicht seine
 *        Entscheidungen durch); ohne sie greift `pickDefaults`.
 * @returns {{bytes:Uint8Array, report:object}}
 */
export function buildRebuild(copies, opts = {}) {
  const { profiles = [], keepHtml = true, note = "" } = opts;
  const cands = collectCandidates(copies, { profiles });
  const sel = opts.selection || pickDefaults(cands, { profiles, ctx: { date: copies[0]?.date } });

  const pool = buildImagePool(copies);
  const src = pickBodySource(copies);
  const rawHtml = src?.html || (looksLikeHtml(src?.bodyText) ? src.bodyText : "");

  let htmlBody = "";
  let inlineImages = [];
  if (keepHtml && rawHtml) {
    htmlBody = buildReaderDocument(rawHtml, {
      images: pool.byCid,
      stems: pool.byStem,
      showHistory: true,
    }).document;
    inlineImages = inlineSetForRebuild(rawHtml, pool)
      .map((i) => {
        const d = dataUrlToBytes(i.dataUrl);
        return d ? { cid: i.cid, contentType: d.contentType, bytes: d.bytes } : null;
      })
      .filter(Boolean);
  }

  // Anhänge byte-genau aus ihren Quell-Kopien holen
  const byId = new Map(copies.map((c) => [c.id, c]));
  const attachments = [];
  for (const st of sel.attachments) {
    if (!st.include) continue;
    const meta = cands.attachments.find((a) => a.key === st.key);
    if (!meta) continue;
    // Im Text eingebundene Bilder stecken schon im Rumpf.
    if (keepHtml && meta.inlineToo) continue;
    const source = meta.sources[0];
    const loaded = byId.get(source.copyId);
    const part = listParts(loaded.bytes).find((p) => p.index === source.index);
    if (!part) continue;
    const ex = extractPart(loaded.bytes, part);
    attachments.push({
      ...ex,
      filenameOriginal: ex.filename,
      filename: st.filename || ex.filename,
    });
  }

  const bytes = assembleMessage({
    headers: {
      from: sel.from,
      to: sel.to,
      cc: sel.cc,
      subject: sel.subject,
      date: sel.date,
      extra: {
        "X-SupaDupa-Merged-From": copies.map((c) => c.id).join(","),
        ...(note ? { "X-SupaDupa-Note": note } : {}),
      },
    },
    bodyText: clean(sel.bodyText),
    htmlBody,
    inlineImages,
    attachments,
  });

  return {
    bytes,
    report: {
      copies: copies.length,
      attachments: attachments.length,
      inlineImages: inlineImages.length,
      keptHtml: Boolean(htmlBody),
      subject: sel.subject,
      to: sel.to,
    },
  };
}
