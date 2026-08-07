// dedupe.js — Duplikate finden und entscheiden, welche Kopie bleibt.
//
// Entwurfsgrundsatz: Das Gruppieren läuft ausschließlich auf den Kopfdaten,
// die `messages.list` ohnehin liefert (Betreff, Absender, Datum, Größe,
// Message-ID). Für einen Ordner mit zehntausenden Mails wäre ein Body-Abruf
// pro Nachricht nicht vertretbar — der Textvergleich passiert deshalb erst
// auf Wunsch und nur innerhalb einer bereits gefundenen Gruppe.

import { parseAddressList } from "./mime.js";
import { checkRecipient } from "./recipients.js";

/** Betreff ohne Antwort-/Weiterleitungs-Vorsätze und Leerraum-Rauschen. */
export function normalizeSubject(subject) {
  return String(subject || "")
    .replace(/^(\s*(re|aw|antw|fw|fwd|wg)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function firstEmail(value) {
  const a = parseAddressList(value || "")[0];
  return (a?.email || "").toLowerCase();
}

/** Kleiner, stabiler Hash (FNV-1a) — nur zum Gruppieren, nicht kryptografisch. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const MODES = {
  /** Nur echte Kopien derselben Nachricht (gleiche Message-ID). */
  strict: "strict",
  /** Message-ID ODER Absender + Betreff + Zeitpunkt (Minute). */
  normal: "normal",
  /** Absender + Betreff + Datum (Tag) — findet auch neu zugestellte Kopien. */
  lose: "lose",
};

/**
 * Gruppierungsschlüssel einer Nachricht.
 * @param {object} h MessageHeader aus messages.list
 */
export function fingerprint(h, mode = MODES.normal) {
  const subject = normalizeSubject(h?.subject);
  const from = firstEmail(h?.author);
  const d = new Date(h?.date || 0);
  const ts = Number.isNaN(d.valueOf()) ? 0 : d.getTime();

  if (mode === MODES.strict) {
    const mid = (h?.headerMessageId || "").trim();
    return mid ? `mid:${mid}` : `fallback:${hash(`${from}|${subject}|${ts}|${h?.size || 0}`)}`;
  }
  if (mode === MODES.lose) {
    const day = ts ? new Date(ts).toISOString().slice(0, 10) : "";
    return `lose:${hash(`${from}|${subject}|${day}`)}`;
  }
  const mid = (h?.headerMessageId || "").trim();
  if (mid) return `mid:${mid}`;
  const minute = Math.floor(ts / 60000);
  return `norm:${hash(`${from}|${subject}|${minute}`)}`;
}

/**
 * Bewertet eine Kopie: Welche ist die beste, die man behalten will?
 * Höher = besser. Vollständige Empfänger-Angabe schlägt alles andere —
 * genau darum geht es beim Aufräumen.
 */
export function scoreCopy(h, profiles = []) {
  let score = 0;
  const recips = parseAddressList((h?.recipients || []).join(", "));
  if (recips.length) {
    recips.forEach((r) => {
      const c = checkRecipient(r, profiles);
      const hasError = c.findings.some((f) => f.level === "error");
      if (hasError) {
        // Ein FALSCHER Name ist schlechter als gar keiner: Er sieht richtig aus
        // und würde beim Aufräumen unbemerkt durchrutschen.
        score -= 60;
      } else if (c.ok) {
        score += 100;
        if (r.name && r.email) score += 40;
      } else {
        score -= 10; // nur Warnung, etwa fehlender Anzeigename
      }
    });
  } else {
    score -= 60; // gar kein Empfänger
  }
  if (h?.flagged) score += 15;
  if ((h?.tags || []).length) score += 10;
  if (h?.read) score += 2;
  score += Math.min(20, Math.round((h?.size || 0) / 50000)); // vollständigere Kopie
  return score;
}

/**
 * Gruppiert Kopfdaten zu Duplikat-Gruppen.
 * @returns {Array<{key:string, messages:object[], keeperId:number, reasons:string[]}>}
 *          nur Gruppen mit mehr als einer Nachricht, größte zuerst.
 */
export function groupDuplicates(headers, { mode = MODES.normal, profiles = [] } = {}) {
  const map = new Map();
  for (const h of headers || []) {
    const key = fingerprint(h, mode);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(h);
  }
  const groups = [];
  for (const [key, messages] of map) {
    if (messages.length < 2) continue;
    const scored = messages
      .map((h) => ({ h, s: scoreCopy(h, profiles) }))
      .sort((a, b) => b.s - a.s || new Date(a.h.date) - new Date(b.h.date));
    groups.push({
      key,
      messages: scored.map((x) => x.h),
      scores: Object.fromEntries(scored.map((x) => [x.h.id, x.s])),
      keeperId: scored[0].h.id,
      reasons: differences(messages),
    });
  }
  groups.sort((a, b) => b.messages.length - a.messages.length);
  return groups;
}

/** Worin unterscheiden sich die Kopien einer Gruppe? */
export function differences(messages) {
  const out = [];
  const uniq = (fn) => [...new Set(messages.map(fn))];
  const recips = uniq((m) => (m.recipients || []).join(", "));
  if (recips.length > 1) out.push("unterschiedliche Empfänger-Angabe");
  const sizes = uniq((m) => m.size || 0);
  if (sizes.length > 1) out.push("unterschiedliche Größe");
  const dates = uniq((m) => new Date(m.date).toISOString().slice(0, 16));
  if (dates.length > 1) out.push("unterschiedlicher Zeitstempel");
  const folders = uniq((m) => m.folder?.path || m.folderId || "");
  if (folders.length > 1) out.push("in mehreren Ordnern");
  if (!out.length) out.push("keine sichtbaren Unterschiede");
  return out;
}

/**
 * Inhalts-Prüfsumme einer Nachricht — DAS zuverlässige Kriterium.
 * Bewusst unabhängig von Empfänger-Zeile, Dateinamen, Reihenfolge der
 * Kopfzeilen und Zeitstempel: Genau die Dinge, die bei deinen Fragmenten
 * abweichen, dürfen die Erkennung nicht stören.
 * @param {{bodyText:string, attachments:Array<{size:number,contentType:string}>}} m
 */
export function contentKey(m) {
  const text = normalizeBody(m?.bodyText);
  const atts = (m?.attachments || [])
    .map((a) => `${a.size || 0}:${(a.contentType || "").toLowerCase()}`)
    .sort()
    .join(",");
  return `${hash(text)}~${hash(atts)}~${(m?.attachments || []).length}`;
}

/** Vergleichsform des Rumpfes: ohne Leerraum-, Zitat- und Umbruch-Rauschen. */
export function normalizeBody(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .toLowerCase()
    .trim();
}

/**
 * Teilt eine über Kopfdaten gebildete Gruppe anhand der Inhalts-Prüfsumme auf.
 * Nachrichten ohne geladenen Inhalt bleiben zusammen (unverifiziert).
 * @param {object} group
 * @param {Map<number, {bodyText:string, attachments:Array}>} contents
 * @returns {Array<object>} eine oder mehrere Gruppen, jeweils mit `verified`
 */
export function verifyGroup(group, contents) {
  const buckets = new Map();
  for (const m of group.messages) {
    const c = contents.get(m.id);
    const key = c ? contentKey(c) : "unverified";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const out = [];
  for (const [key, messages] of buckets) {
    if (messages.length < 2) continue;
    const keeper = messages.find((m) => m.id === group.keeperId) || messages[0];
    out.push({
      ...group,
      key: `${group.key}#${key}`,
      messages,
      keeperId: keeper.id,
      verified: key !== "unverified",
      reasons: differences(messages),
    });
  }
  return out;
}

/** Zusammenfassung für die Kopfzeile. */
export function summarize(groups) {
  const total = groups.reduce((n, g) => n + g.messages.length, 0);
  const removable = groups.reduce((n, g) => n + g.messages.length - 1, 0);
  return { groups: groups.length, total, removable };
}

/** IDs, die in einer Gruppe entfernt werden können (alles außer der Kopie, die bleibt). */
export function removableIds(group) {
  return group.messages.filter((m) => m.id !== group.keeperId).map((m) => m.id);
}
