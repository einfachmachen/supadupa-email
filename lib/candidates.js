// candidates.js — Modell für den Leuchttisch.
//
// Aus mehreren zusammengehörigen Kopien werden je Bestandteil (Betreff,
// Absender, Empfänger, Datum, Text, jeder einzelne Anhang) die vorhandenen
// *Varianten* gesammelt, bewertet und vorausgewählt. Die Oberfläche zeigt sie
// ringsum; ausgewählt wird pro Bestandteil, nicht pro Mail.

import { comparable, clean, describeJunk } from "./textclean.js";
import { checkRecipientList, applySuggestions } from "./recipients.js";
import { checkAttachment, suggestName } from "./attachments.js";
import { parseAddressList, decodeHeaderValue } from "./mime.js";
import { attachmentKey, isTinyAttachment } from "./attachcontent.js";

/** Fasst gleiche Werte zusammen und merkt sich, aus welchen Kopien sie kommen. */
function variants(copies, pick, { normalize = (v) => String(v || "").trim() } = {}) {
  const map = new Map();
  for (const c of copies) {
    const raw = pick(c);
    const value = String(raw ?? "").trim();
    const key = normalize(value);
    if (!map.has(key)) map.set(key, { value, key, sources: [] });
    map.get(key).sources.push(c.id);
    // die vollständigere Schreibweise gewinnt als Anzeigewert
    if (value.length > map.get(key).value.length) map.get(key).value = value;
  }
  return [...map.values()];
}

/** Bewertet Empfänger-Varianten (vollständig + profilkonform = beste). */
function scoreRecipients(value, profiles) {
  const res = checkRecipientList(value || "", profiles);
  if (res.empty) return -100;
  let s = 0;
  for (const r of res.results) {
    if (r.findings.some((f) => f.level === "error")) s -= 60;
    else if (r.ok) s += r.name && r.email ? 140 : 100;
    else s -= 10;
  }
  return s;
}

/** Alle Bestandteile aller Kopien einsammeln. */
export function collectCandidates(copies, { profiles = [] } = {}) {
  // Antwort-/Weiterleitungs-Vorsätze fliegen raus: „AW: Rechnung 42" und
  // „Rechnung 42" sind derselbe Betreff, und der neue soll ohne Vorsatz sein.
  const stripPrefix = (v) => String(v || "").replace(/^(\s*(re|aw|antw|fwd?|wg)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
  const subjects = variants(copies, (c) => stripPrefix(decodeHeaderValue(c.subject)), {
    normalize: (v) => v.toLowerCase(),
  }).map((v) => ({ ...v, issues: v.value ? [] : ["kein Betreff"] }));

  const froms = variants(copies, (c) => c.from).map((v) => ({ ...v, issues: [] }));

  const mkAddr = (field) =>
    // Bewusst nach der VOLLEN Schreibweise gruppiert, nicht nur nach der
    // Adresse: „max@example.de" und „Max Mustermann <max@example.de>" sind
    // genau die Wahl, die der Leuchttisch anbieten soll.
    variants(copies, (c) => c[field], {
      normalize: (v) =>
        parseAddressList(v)
          .map((a) => `${a.name.toLowerCase().trim()}|${a.email.toLowerCase()}`)
          .sort()
          .join(","),
    })
      .map((v) => {
        const score = scoreRecipients(v.value, profiles);
        const fixed = applySuggestions(v.value, profiles);
        const res = checkRecipientList(v.value, profiles);
        return {
          ...v,
          score,
          suggestion: fixed && fixed !== v.value.trim() ? fixed : "",
          issues: res.results.flatMap((r) => r.findings.map((f) => f.text)),
        };
      })
      .sort((a, b) => b.score - a.score);

  const dates = variants(copies, (c) => c.date).map((v) => ({ ...v, issues: [] }));

  const bodies = variants(copies, (c) => c.bodyText, { normalize: comparable })
    .map((v) => {
      const junk = describeJunk(v.value);
      return {
        ...v,
        cleaned: clean(v.value),
        junk,
        length: comparable(v.value).length,
        issues: junk ? [`enthält ${junk}`] : [],
      };
    })
    .sort((a, b) => b.length - a.length || b.sources.length - a.sources.length);

  return {
    subjects,
    froms,
    tos: mkAddr("to"),
    ccs: mkAddr("cc"),
    dates,
    bodies,
    attachments: collectAttachments(copies),
  };
}

/**
 * Anhänge über alle Kopien hinweg zusammenführen.
 * Derselbe Anhang wird an Größe + MIME-Typ wiedererkannt; die Namensvarianten
 * hängen als Auswahl daran. So taucht ein Anhang, den nur EINE Kopie hat,
 * trotzdem in der Liste auf — genau der Fall, um den es geht.
 */
export function collectAttachments(copies) {
  const map = new Map();
  for (const c of copies) {
    for (const a of c.attachments || []) {
      // Inhalts-Hash schlägt Größe+Typ: Nur so fallen 10 Kopien desselben
      // PDFs zu EINEM Eintrag zusammen, auch wenn sie unterschiedlich
      // kodiert sind — und nur so bleiben zwei zufällig gleich große,
      // aber verschiedene Dateien getrennt.
      const key = attachmentKey(a);
      if (!map.has(key)) {
        map.set(key, {
          key,
          hash: a.hash || "",
          size: a.size || 0,
          contentType: a.contentType || "",
          names: [],
          sources: [],
          inlineToo: false,
        });
      }
      const entry = map.get(key);
      entry.sources.push({ copyId: c.id, index: a.index, name: a.name || "" });
      if (a.name && !entry.names.includes(a.name)) entry.names.push(a.name);
      // Bild, das im HTML per cid: eingebunden ist UND als Anhang deklariert
      // wurde (Outlook-Muster) — beim Neubau darf es nicht doppelt landen.
      if (a.inlineToo) entry.inlineToo = true;
      if (!entry.size && a.size) entry.size = a.size;
      if (!entry.contentType && a.contentType) entry.contentType = a.contentType;
    }
  }
  return [...map.values()].sort((a, b) => b.size - a.size);
}

/**
 * Vorauswahl: bester Betreff, beste Empfänger, längster sauberer Text,
 * alle Anhänge an, jeweils mit dem plausibelsten Namen.
 */
export function pickDefaults(cands, { profiles = [], ctx = {} } = {}) {
  const first = (list) => (list && list.length ? list[0] : null);
  const bestBody =
    cands.bodies.find((b) => !b.junk && b.length > 0) || first(cands.bodies) || { value: "" };
  const bestSubject =
    cands.subjects.find((s) => s.value) || first(cands.subjects) || { value: "" };

  const context = {
    subject: bestSubject.value,
    body: bestBody.cleaned ?? bestBody.value,
    date: ctx.date || first(cands.dates)?.value,
  };

  const attachments = cands.attachments.map((a) => {
    const best = bestAttachmentName(a, context);
    return {
      key: a.key,
      // Im Text eingebundene Bilder gehören zum Rumpf, nicht in die
      // Anhangsliste der neuen Nachricht — sonst hängen sie doppelt dran.
      // Winzige Teile (0/2/4 Byte, Zählpixel) sind ebenfalls ab.
      include: !a.inlineToo && !isTinyAttachment(a.size),
      inlineToo: Boolean(a.inlineToo),
      tiny: isTinyAttachment(a.size),
      filename: best.name,
      reason: best.reason,
      source: best.source,
    };
  });

  const to = first(cands.tos);
  const cc = first(cands.ccs);
  return {
    subject: bestSubject.value,
    from: first(cands.froms)?.value || "",
    to: (to?.suggestion || to?.value) ?? "",
    cc: (cc?.suggestion || cc?.value) ?? "",
    date: first(cands.dates)?.value || "",
    bodyKey: bestBody.key,
    bodyText: bestBody.cleaned ?? bestBody.value,
    attachments,
    context,
  };
}

/** Bester vorhandener Name eines Anhangs — sonst ein gebildeter Vorschlag. */
export function bestAttachmentName(att, ctx = {}) {
  let best = null;
  for (const name of att.names) {
    const check = checkAttachment(
      { name, contentType: att.contentType, size: att.size },
      ctx
    );
    const quality = check.plausible ? 2 : check.findings.some((f) => f.level === "error") ? 0 : 1;
    if (!best || quality > best.quality) {
      best = { name, quality, source: att.sources.find((s) => s.name === name)?.copyId };
    }
  }
  if (best && best.quality === 2) {
    return { name: best.name, reason: "vorhandener, plausibler Name", source: best.source };
  }
  const proposed = suggestName(
    { name: best?.name || `anhang${extFor(att.contentType)}` },
    ctx
  );
  if (proposed) {
    return {
      name: proposed,
      reason: best?.name ? "Name gebildet (vorhandener war nichtssagend)" : "Anhang hatte keinen Namen",
      source: null,
    };
  }
  return { name: best?.name || "anhang", reason: "unverändert", source: best?.source };
}

function extFor(contentType) {
  const map = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
    "application/zip": ".zip",
  };
  return map[(contentType || "").toLowerCase()] || "";
}

/**
 * Überlagerung für den Leuchttisch: alle Textvarianten zeilenweise
 * übereinandergelegt. Jede Zeile weiß, in welchen Varianten sie vorkommt.
 * @returns {Array<{text:string, inAll:boolean, sources:string[]}>}
 */
export function overlayLines(bodies) {
  const perVariant = bodies.map((b) => ({
    key: b.key,
    lines: comparable(b.value).split("\n").filter(Boolean),
    display: clean(b.value).split("\n"),
  }));
  const order = [];
  const seen = new Map();
  for (const v of perVariant) {
    v.display.forEach((display, i) => {
      const norm = comparable(display);
      if (!norm) return;
      if (!seen.has(norm)) {
        seen.set(norm, { text: display, sources: [], order: order.length + i / 1000 });
        order.push(norm);
      }
      const entry = seen.get(norm);
      if (!entry.sources.includes(v.key)) entry.sources.push(v.key);
    });
  }
  return order.map((norm) => {
    const e = seen.get(norm);
    return {
      text: e.text,
      sources: e.sources,
      inAll: e.sources.length === perVariant.length,
    };
  });
}
