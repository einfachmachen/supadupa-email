// inlineparts.js — eingebettete Bilder über alle Kopien hinweg einsammeln.
//
// Ein `cid:`-Bild lebt nur in der Kopie, die es mitliefert. Fehlt es dort
// (abgeschnittene Weiterleitung, Archivierung ohne Anhänge), zeigt der
// Betrachter einen grauen Kasten. Oft steckt dasselbe Bild aber noch in einer
// Geschwister-Kopie — nur unter anderer Content-ID, weil Outlook beim
// Weiterleiten neue IDs vergibt. Genau diese Lücke schließt dieses Modul.

import { cidStem, listCidRefs } from "./htmlmail.js";

/**
 * Baut den Bilder-Vorrat aus allen Kopien.
 * @param {Array<{id:number, inline:Array<{cid,contentType,dataUrl,size,hash}>}>} copies
 * @returns {{byCid:Map, byStem:Map, all:Array}}
 */
export function buildImagePool(copies) {
  const byCid = new Map();
  const byStem = new Map();
  const all = [];
  for (const c of copies || []) {
    for (const img of c.inline || []) {
      if (!img.cid || !img.dataUrl) continue;
      const entry = { ...img, copyId: c.id };
      all.push(entry);
      if (!byCid.has(img.cid)) byCid.set(img.cid, img.dataUrl);
      const stem = cidStem(img.cid);
      // Größere Fassung gewinnt: abgeschnittene Kopien tragen manchmal nur
      // ein Vorschaubild unter demselben Namen.
      const prev = byStem.get(stem);
      if (!prev || (img.size || 0) > (prev.size || 0)) {
        byStem.set(stem, img.dataUrl);
        byStem.set(`${stem}::meta`, entry);
      }
    }
  }
  return { byCid, byStem, all };
}

/**
 * Bestandsaufnahme: Welche cid-Verweise stehen im HTML, was davon lässt sich
 * auflösen — und woher?
 * @returns {Array<{cid:string, state:"ok"|"ersetzt"|"fehlt", from:number|null, stem:string}>}
 */
export function auditInlineImages(html, pool) {
  const refs = listCidRefs(html);
  return refs.map((cid) => {
    if (pool.byCid.has(cid)) {
      const own = pool.all.find((i) => i.cid === cid);
      return { cid, state: "ok", from: own?.copyId ?? null, stem: cidStem(cid) };
    }
    const stem = cidStem(cid);
    const alt = pool.byStem.get(`${stem}::meta`);
    if (alt) return { cid, state: "ersetzt", from: alt.copyId, stem };
    return { cid, state: "fehlt", from: null, stem };
  });
}

/** Kurzfassung für die Oberfläche. */
export function summarizeInline(audit) {
  const ok = audit.filter((a) => a.state === "ok").length;
  const filled = audit.filter((a) => a.state === "ersetzt").length;
  const missing = audit.filter((a) => a.state === "fehlt").length;
  const parts = [];
  if (ok) parts.push(`${ok} vorhanden`);
  if (filled) parts.push(`${filled} aus anderer Kopie ergänzt`);
  if (missing) parts.push(`${missing} fehlen`);
  return { ok, filled, missing, text: parts.join(", ") || "keine eingebetteten Bilder" };
}

/**
 * Was für den Neubau als eingebettetes Bild mitmuss: für jeden auflösbaren
 * cid-Verweis genau ein Teil, unter der IM HTML BENUTZTEN Content-ID.
 * @returns {Array<{cid:string, dataUrl:string, from:number|null}>}
 */
export function inlineSetForRebuild(html, pool) {
  const out = [];
  for (const a of auditInlineImages(html, pool)) {
    if (a.state === "fehlt") continue;
    const dataUrl = pool.byCid.get(a.cid) || pool.byStem.get(a.stem);
    if (dataUrl) out.push({ cid: a.cid, dataUrl, from: a.from });
  }
  return out;
}

/** data:-URL → { contentType, bytes } */
export function dataUrlToBytes(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(url || ""));
  if (!m) return null;
  const [, contentType, isB64, payload] = m;
  if (!isB64) {
    const text = decodeURIComponent(payload);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return { contentType, bytes };
  }
  const bin =
    typeof atob === "function"
      ? atob(payload)
      : Buffer.from(payload, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { contentType, bytes };
}
