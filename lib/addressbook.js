// addressbook.js — alle Namen und Adressen eines Ordners einsammeln.
//
// Der Zweck: Bevor man Mail für Mail Empfänger korrigiert, legt man EINMAL
// fest, wie jede Adresse richtig heißt. Daraus werden Profile — und ab dann
// zeigt der Leuchttisch überall gleich den richtigen Namen an.
//
// Gearbeitet wird auf den Kopfdaten, die `messages.list` ohnehin liefert
// (author, recipients, ccList) — kein zusätzlicher Abruf.

import { parseAddressList } from "./mime.js";
import { normalizeEmail, normalizeName, sameName } from "./recipients.js";

/** Alle Adress-Felder einer Kopfzeile, mit ihrer Rolle. */
function addressesOf(header) {
  const out = [];
  const push = (value, role) => {
    for (const a of parseAddressList(value || "")) {
      if (a.email || a.name) out.push({ ...a, role });
    }
  };
  push(header?.author, "from");
  for (const r of header?.recipients || []) push(r, "to");
  for (const c of header?.ccList || []) push(c, "cc");
  for (const b of header?.bccList || []) push(b, "bcc");
  return out;
}

/**
 * Zählt, welche Schreibweisen zu welcher Adresse vorkommen.
 * @param {Array} headers Kopfdaten (aus listAllMessages)
 * @returns {Array<{email, count, roles:Set, names:Array<{name,count}>, blank:number}>}
 */
export function collectAddressUsage(headers) {
  const map = new Map();
  for (const h of headers || []) {
    for (const a of addressesOf(h)) {
      const email = normalizeEmail(a.email);
      if (!email) continue; // Einträge ohne Adresse taugen nicht als Schlüssel
      if (!map.has(email)) {
        map.set(email, { email, count: 0, roles: new Set(), names: new Map(), blank: 0 });
      }
      const e = map.get(email);
      e.count++;
      e.roles.add(a.role);
      const name = String(a.name || "").trim();
      if (name) e.names.set(name, (e.names.get(name) || 0) + 1);
      else e.blank++;
    }
  }
  return [...map.values()]
    .map((e) => ({
      ...e,
      roles: [...e.roles],
      names: [...e.names.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));
}

/** Sieht der Name nur nach der Adresse aus? (dann taugt er nicht als Vorschlag) */
function looksLikeAddress(name, email) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return true;
  if (n.includes("@")) return true;
  const local = String(email || "").split("@")[0];
  return !!local && normalizeName(n) === normalizeName(local);
}

/**
 * Vorschlag für die richtige Schreibweise: die häufigste, die wie ein echter
 * Name aussieht — bei Gleichstand die ausführlichere.
 */
export function suggestPreferred(entry) {
  const real = (entry.names || []).filter((n) => !looksLikeAddress(n.name, entry.email));
  if (!real.length) return "";
  const top = real.reduce((best, n) =>
    n.count > best.count || (n.count === best.count && n.name.length > best.name.length) ? n : best
  );
  return top.name;
}

/** Wie viele Vorkommen weichen vom Vorschlag ab? Das ist die Arbeitsmenge. */
export function countDeviations(entry, preferred) {
  if (!preferred) return entry.blank;
  const wrongNames = (entry.names || [])
    .filter((n) => !sameName(n.name, preferred))
    .reduce((sum, n) => sum + n.count, 0);
  return entry.blank + wrongNames;
}

/**
 * Bewertet einen Eintrag für die Anzeige.
 * @returns {{email, count, preferred, deviations, variants, needsWork, roles}}
 */
export function assessEntry(entry) {
  const preferred = suggestPreferred(entry);
  const deviations = countDeviations(entry, preferred);
  return {
    email: entry.email,
    count: entry.count,
    roles: entry.roles,
    names: entry.names,
    blank: entry.blank,
    preferred,
    deviations,
    variants: entry.names.length + (entry.blank ? 1 : 0),
    // Handlungsbedarf: mehrere Schreibweisen, gar kein Name, oder nur ein
    // Name, der wie die Adresse aussieht.
    needsWork: deviations > 0 || !preferred,
  };
}

/** Der ganze Ordner auf einen Blick. */
export function buildFolderBook(headers) {
  return collectAddressUsage(headers).map(assessEntry);
}

/**
 * Aus den (ggf. von Hand korrigierten) Festlegungen Profile bauen.
 * Bestehende Profile bleiben erhalten; eine Adresse wandert in genau ein Profil.
 * @param {Array<{email, preferred, names}>} decisions
 * @param {Array} existing bisherige Profile
 */
export function mergeIntoProfiles(decisions, existing = []) {
  const profiles = existing.map((p) => ({
    ...p,
    names: [...(p.names || [])],
    emails: [...(p.emails || [])],
  }));
  const findFor = (email) =>
    profiles.find((p) => (p.emails || []).some((e) => normalizeEmail(e) === normalizeEmail(email)));

  let added = 0;
  let updated = 0;
  for (const d of decisions || []) {
    const email = normalizeEmail(d.email);
    const preferred = String(d.preferred || "").trim();
    if (!email || !preferred) continue;

    const alt = (d.names || [])
      .map((n) => (typeof n === "string" ? n : n.name))
      .filter((n) => n && !sameName(n, preferred));

    const existingProfile = findFor(email);
    if (existingProfile) {
      existingProfile.preferredName = preferred;
      for (const n of alt) {
        if (!existingProfile.names.some((x) => sameName(x, n))) existingProfile.names.push(n);
      }
      updated++;
    } else {
      profiles.push({
        id: `book:${email}`,
        label: email,
        preferredName: preferred,
        names: [...new Set(alt)],
        emails: [email],
      });
      added++;
    }
  }
  return { profiles, added, updated };
}

/** Kurzfassung für die Kopfzeile der Klappe. */
export function summarizeBook(book) {
  const total = book.length;
  const work = book.filter((e) => e.needsWork).length;
  const deviations = book.reduce((n, e) => n + e.deviations, 0);
  return {
    total,
    work,
    deviations,
    text: total
      ? `${total} Adressen · ${work} mit uneinheitlicher Schreibweise · ${deviations} Vorkommen betroffen`
      : "keine Adressen gefunden",
  };
}
