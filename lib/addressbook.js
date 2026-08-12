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

/**
 * Ersatzadressen von Exchange/Microsoft 365.
 *
 * Wenn ein Postfach umgezogen oder abgeschaltet ist, ersetzt Outlook die
 * ursprüngliche Firmenadresse beim Speichern durch die interne Kennung des
 * Servers — entweder als `IMCEAEX-…@…prod.outlook.com` oder als `X500:`-Eintrag.
 * Die Firmendomain steht dann nirgends mehr; erhalten bleibt meist nur der Name
 * am Ende der Kennung. Genau das holen wir hier heraus, damit man die richtige
 * Adresse einmal festlegen kann.
 */
const REPLACEMENT_PATTERNS = [
  { re: /^imceaex-/i, why: "Exchange-Ersatzadresse (IMCEAEX)" },
  { re: /^x500:/i, why: "Exchange-Ersatzadresse (X500)" },
];
const REPLACEMENT_DOMAINS = [
  { re: /\.prod\.outlook\.com$/i, why: "interne Microsoft-365-Domain" },
  { re: /\.onmicrosoft\.com$/i, why: "Microsoft-365-Ausweichdomain" },
];

/** `+20` / `%20` in der Exchange-Kennung zurückübersetzen. */
function decodePlusHex(s) {
  return String(s || "").replace(/[+%]([0-9a-fA-F]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * Erkennt eine Ersatzadresse und holt den Namen heraus, der darin steckt.
 * @returns {{replacement:boolean, why:string, nameHint:string}}
 */
export function decodeExchangeAddress(email) {
  const raw = String(email || "").trim();
  const local = raw.split("@")[0] || "";
  const domain = (raw.split("@")[1] || "").toLowerCase();

  let why = "";
  for (const p of REPLACEMENT_PATTERNS) if (p.re.test(raw)) why = p.why;
  if (!why) for (const d of REPLACEMENT_DOMAINS) if (d.re.test(domain)) why = d.why;
  if (!why) return { replacement: false, why: "", nameHint: "" };

  // Der Klarname steht am Ende des letzten `cn=`-Abschnitts, hinter der
  // Kennungs-Zahl: „…_cn=59cb…c1-dirk+20trowe“ → „dirk trowe“.
  let hint = "";
  const parts = decodePlusHex(local).split(/_?cn=/i);
  const tail = parts.length > 1 ? parts[parts.length - 1] : "";
  const afterId = tail.match(/^[0-9a-f]{8,}-(.+)$/i);
  hint = (afterId ? afterId[1] : tail).replace(/[._]+/g, " ").trim();
  if (/^[0-9a-f]+$/i.test(hint) || hint.length < 3) hint = "";

  return { replacement: true, why, nameHint: hint };
}

/**
 * Sucht im Ordner eine brauchbare Adresse für einen Eintrag, dessen eigene
 * Adresse nur eine Ersatzkennung ist: dieselbe Person schreibt fast immer auch
 * von einer echten Adresse aus. Gesucht wird über den Anzeigenamen.
 */
export function suggestEmailFor(entry, book = []) {
  const info = decodeExchangeAddress(entry.email);
  if (!info.replacement) return "";
  const wanted = [suggestPreferred(entry), info.nameHint].filter(Boolean);
  if (!wanted.length) return "";
  const other = book.filter(
    (e) => e.email !== entry.email && !decodeExchangeAddress(e.email).replacement
  );
  const hit = other.find((e) =>
    (e.names || []).some((n) => wanted.some((w) => sameName(n.name, w)))
  );
  return hit ? hit.email : "";
}

/** Rollen in Worten — „from/to“ sagt beim Durchsehen zu wenig. */
export function describeRoles(roles = []) {
  const words = {
    from: "als Absender",
    to: "als Empfänger",
    cc: "in Kopie",
    bcc: "in Blindkopie",
  };
  const list = roles.map((r) => words[r] || r);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} und ${list[list.length - 1]}`;
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
  const exchange = decodeExchangeAddress(entry.email);
  return {
    replacement: exchange.replacement,
    replacementWhy: exchange.why,
    nameHint: exchange.nameHint,
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
    // Handlungsbedarf auch dann, wenn die Adresse selbst nur eine
    // Server-Ersatzkennung ist — der Name mag stimmen, die Adresse nicht.
    needsWork: deviations > 0 || !preferred || exchange.replacement,
  };
}

/** Der ganze Ordner auf einen Blick. */
export function buildFolderBook(headers) {
  const book = collectAddressUsage(headers).map(assessEntry);
  // Zweiter Durchgang: Ersatzadressen können erst zugeordnet werden, wenn alle
  // echten Adressen des Ordners bekannt sind.
  for (const e of book) {
    e.emailSuggestion = e.replacement ? suggestEmailFor(e, book) : "";
  }
  return book;
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
    // Die richtige Adresse — falls die gefundene nur eine Ersatzkennung war.
    const preferredEmail = normalizeEmail(d.preferredEmail);
    const targetEmail = preferredEmail && preferredEmail !== email ? preferredEmail : "";
    if (!email || (!preferred && !targetEmail)) continue;

    const alt = (d.names || [])
      .map((n) => (typeof n === "string" ? n : n.name))
      .filter((n) => n && !sameName(n, preferred));

    // Zeigt die Ersatzadresse auf eine echte, gehören beide in EIN Profil —
    // sonst widersprechen sich die beiden Einträge später gegenseitig.
    const existingProfile = findFor(targetEmail) || findFor(email);
    if (existingProfile) {
      if (preferred) existingProfile.preferredName = preferred;
      for (const n of alt) {
        if (!existingProfile.names.some((x) => sameName(x, n))) existingProfile.names.push(n);
      }
      for (const e of [targetEmail, email]) {
        if (e && !existingProfile.emails.some((x) => normalizeEmail(x) === e)) {
          existingProfile.emails.push(e);
        }
      }
      if (targetEmail) existingProfile.preferredEmail = targetEmail;
      updated++;
    } else {
      profiles.push({
        id: `book:${targetEmail || email}`,
        label: targetEmail || email,
        preferredName: preferred,
        names: [...new Set(alt)],
        emails: targetEmail ? [targetEmail, email] : [email],
        ...(targetEmail ? { preferredEmail: targetEmail } : {}),
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
  const replacements = book.filter((e) => e.replacement).length;
  return {
    total,
    work,
    deviations,
    replacements,
    text: total
      ? `${total} Adressen · ${work} mit uneinheitlicher Schreibweise · ${deviations} Vorkommen betroffen` +
        (replacements ? ` · ${replacements} Ersatzadresse${replacements === 1 ? "" : "n"}` : "")
      : "keine Adressen gefunden",
  };
}
