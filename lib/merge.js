// merge.js — aus mehreren unvollständigen Kopien einer Nachricht EINE
// vollständige bauen.
//
// Grundregel: Es wird nichts erfunden und nichts zusammengeschnitten, was
// nicht zusammengehört. Eine Kopie wird zur **Grundlage** (die mit den
// meisten/größten Anhängen — nur dort liegen die Nutzdaten wirklich vor),
// und von den Geschwistern werden ausschließlich **Kopfdaten** übernommen:
// die beste Empfänger-Zeile und die besten Dateinamen. Der Rumpf der
// Grundlage bleibt Byte für Byte erhalten.

import { checkRecipientList, applySuggestions } from "./recipients.js";
import { checkAttachment, suggestName, splitName } from "./attachments.js";
import { parseAddressList, formatAddressList } from "./mime.js";

/** Wie gut ist eine Empfänger-Zeile? Höher = besser. */
export function recipientScore(value, profiles = []) {
  const res = checkRecipientList(value || "", profiles);
  if (res.empty) return -100;
  let score = 0;
  for (const r of res.results) {
    if (r.findings.some((f) => f.level === "error")) score -= 60;
    else if (r.ok) score += r.name && r.email ? 140 : 100;
    else score -= 10;
  }
  return score;
}

/** Die Kopie, die die Nutzdaten stellt: meiste Anhänge, dann größte. */
export function pickBase(copies) {
  const rank = (c) => {
    const atts = c.attachments || [];
    const named = atts.filter((a) => a.name).length;
    const bytes = atts.reduce((n, a) => n + (a.size || 0), 0);
    return [atts.length, named, bytes, c.size || 0];
  };
  return [...copies].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (rb[i] !== ra[i]) return rb[i] - ra[i];
    return 0;
  })[0];
}

/** Beste Empfänger-Zeile aus allen Kopien, danach noch profilkorrigiert. */
export function bestRecipients(copies, profiles = [], field = "to") {
  let best = { value: "", score: -Infinity, fromId: null };
  for (const c of copies) {
    const raw = c[field] || "";
    const score = recipientScore(raw, profiles);
    if (score > best.score) best = { value: raw, score, fromId: c.id };
  }
  if (best.score === -Infinity) return { value: "", fromId: null, corrected: false };
  const fixed = applySuggestions(best.value, profiles);
  const corrected = !!fixed && fixed !== String(best.value).trim();
  return {
    value: fixed || best.value,
    fromId: best.fromId,
    corrected,
    score: best.score,
  };
}

/**
 * Sammelt aus allen Kopien die brauchbaren Dateinamen, geschlüsselt nach
 * Größe+Typ — so lässt sich ein guter Name einer Kopie auf denselben Anhang
 * der Grundlage übertragen.
 */
export function donorNames(copies, ctx = {}) {
  const byKey = new Map();
  for (const c of copies) {
    for (const a of c.attachments || []) {
      if (!a.name) continue;
      const check = checkAttachment(a, ctx);
      const key = `${a.size || 0}|${(a.contentType || "").toLowerCase()}`;
      const prev = byKey.get(key);
      const quality = check.plausible ? 2 : check.findings.some((f) => f.level === "error") ? 0 : 1;
      if (!prev || quality > prev.quality) {
        byKey.set(key, { name: a.name, quality, fromId: c.id });
      }
    }
  }
  return byKey;
}

/**
 * Plant die Umbenennung der Anhänge der Grundlage.
 * @param {Array<{index:number, filename:string, contentType:string, size?:number}>} parts
 *        Anhang-Teile der Grundlage (aus mimeparts.listAttachmentParts)
 * @param {object} ctx {subject, body, date}
 * @param {Map} donors Ergebnis von donorNames()
 */
export function planRenames(parts, ctx = {}, donors = new Map()) {
  const renames = [];
  const used = new Set();
  for (const p of parts) {
    const current = p.filename || "";
    const key = `${p.size || 0}|${(p.contentType || "").toLowerCase()}`;
    const donor = donors.get(key);
    const check = checkAttachment(
      { name: current, contentType: p.contentType, size: p.size },
      ctx
    );

    let target = current;
    let reason = "";
    if (!check.plausible || !current) {
      if (donor && donor.name && donor.name !== current && donor.quality === 2) {
        target = donor.name;
        reason = "Name aus einer anderen Kopie übernommen";
      } else {
        const proposed = suggestName({ name: current || guessExt(p) }, ctx);
        if (proposed && splitName(proposed).base) {
          target = proposed;
          reason = current ? "Name aus Betreff/Belegnummer gebildet" : "Anhang hatte keinen Namen";
        }
      }
    }
    if (target && target !== current) {
      let unique = target;
      let n = 2;
      while (used.has(unique.toLowerCase())) {
        const { base, ext } = splitName(target);
        unique = ext ? `${base}-${n}.${ext}` : `${base}-${n}`;
        n++;
      }
      used.add(unique.toLowerCase());
      renames.push({ index: p.index, from: current, filename: unique, reason });
    } else if (current) {
      used.add(current.toLowerCase());
    }
  }
  return renames;
}

function guessExt(part) {
  const map = {
    "application/pdf": "anhang.pdf",
    "image/jpeg": "anhang.jpg",
    "image/png": "anhang.png",
    "text/csv": "anhang.csv",
    "application/zip": "anhang.zip",
  };
  return map[(part.contentType || "").toLowerCase()] || "anhang";
}

/**
 * Vollständiger Zusammenführungs-Plan für eine Duplikat-Gruppe.
 * @param {{copies:Array, profiles:Array, baseParts:Array, ctx:object}} input
 *        `copies` = alle Kopien mit {id, to, cc, attachments, size, header}
 *        `baseParts` = Anhang-Teile der gewählten Grundlage
 */
export function buildMergePlan({ copies, profiles = [], baseParts = [], ctx = {}, baseId = null }) {
  const base = baseId ? copies.find((c) => c.id === baseId) : pickBase(copies);
  const to = bestRecipients(copies, profiles, "to");
  const cc = bestRecipients(copies, profiles, "cc");
  const donors = donorNames(copies, ctx);
  const renames = planRenames(baseParts, ctx, donors);

  const notes = [];
  notes.push(`Grundlage: Kopie ${base?.id} (${(base?.attachments || []).length} Anhänge).`);
  if (to.fromId && to.fromId !== base?.id) {
    notes.push(`Empfänger-Zeile stammt aus Kopie ${to.fromId}.`);
  }
  if (to.corrected) notes.push("Empfänger-Zeile wurde zusätzlich anhand der Profile korrigiert.");
  if (!to.value) notes.push("ACHTUNG: Keine Kopie hat eine brauchbare Empfänger-Zeile.");
  for (const r of renames) {
    notes.push(`Anhang „${r.from || "(ohne Namen)"}“ → „${r.filename}“ (${r.reason}).`);
  }
  if (!renames.length && baseParts.length) notes.push("Alle Dateinamen waren bereits plausibel.");

  const headers = {};
  if (to.value) headers.To = to.value;
  if (cc.value) headers.Cc = cc.value;

  return {
    baseId: base?.id ?? null,
    headers,
    renames,
    notes,
    removableIds: copies.map((c) => c.id),
    complete: Boolean(to.value) && renames.every((r) => r.filename),
  };
}

/** Adressliste zweier Kopien vereinen (ohne Dubletten), falls gewünscht. */
export function unionAddresses(...values) {
  const seen = new Map();
  for (const v of values) {
    for (const a of parseAddressList(v || "")) {
      const key = (a.email || a.name).toLowerCase();
      const prev = seen.get(key);
      if (!prev || (!prev.name && a.name)) seen.set(key, a);
    }
  }
  return formatAddressList([...seen.values()]);
}
