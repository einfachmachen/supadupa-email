// recipients.js — Prüfung und Reparatur der Empfänger-Adresse.
//
// Datenmodell "Profil" (in storage.local unter `profiles`):
//   { id, label, preferredName, names: [...weitere Schreibweisen], emails: [...] }
// Ein Profil bündelt einen deiner Namen mit den Adressen, unter denen du ihn
// benutzt. Daraus entsteht die Erwartung „zu dieser Adresse gehört dieser Name“.

import { isPlausibleEmail, parseAddressList, formatAddressList } from "./mime.js";

const TYPO_DOMAINS = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.de": "gmail.com",
  "googlemail.de": "googlemail.com",
  "gmx.ed": "gmx.de",
  "web.se": "web.de",
  "wed.de": "web.de",
  "hotmial.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "yaho.de": "yahoo.de",
};

export function normalizeName(n) {
  return String(n || "")
    .toLowerCase()
    .replace(/[.,_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

/** Alle Schreibweisen eines Profils (bevorzugter Name zuerst). */
export function profileNames(p) {
  return [p?.preferredName, ...(p?.names || [])].filter(Boolean);
}

/** Findet das Profil, zu dem eine Adresse gehört. */
export function profileForEmail(profiles, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return (
    (profiles || []).find((p) =>
      (p.emails || []).some((x) => normalizeEmail(x) === e)
    ) || null
  );
}

/** Namen, die auf dieselbe Person zeigen ("Mustermann, Max" ≙ "Max Mustermann"). */
export function sameName(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(" ").sort().join(" ");
  const wb = nb.split(" ").sort().join(" ");
  return wa === wb;
}

/** Sieht der Name nur nach der Adresse aus (z. B. „max.mustermann“)? */
function nameIsEmailish(name, email) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  if (n.includes("@")) return true;
  const local = normalizeEmail(email).split("@")[0];
  return !!local && normalizeName(n) === normalizeName(local);
}

/**
 * Prüft eine einzelne Empfänger-Angabe gegen die hinterlegten Profile.
 * @returns {{name,email,findings:[],suggestion:{name,email}|null,ok:boolean}}
 */
export function checkRecipient(rec, profiles = []) {
  const name = String(rec?.name || "").trim();
  const email = String(rec?.email || "").trim();
  const findings = [];
  const add = (level, code, text) => findings.push({ level, code, text });
  let suggestion = null;

  if (!email) {
    add("error", "no-email", "Keine E-Mail-Adresse — nur ein Name steht da.");
    const byName = (profiles || []).find((p) =>
      profileNames(p).some((n) => sameName(n, name))
    );
    if (byName?.emails?.[0]) {
      suggestion = { name: byName.preferredName || name, email: byName.emails[0] };
    }
  } else if (!isPlausibleEmail(email)) {
    add("error", "bad-email", `„${email}“ ist keine gültige Adresse.`);
  } else {
    const domain = email.split("@")[1]?.toLowerCase();
    if (TYPO_DOMAINS[domain]) {
      add("error", "typo-domain", `Domain „${domain}“ — gemeint ist wohl „${TYPO_DOMAINS[domain]}“.`);
      suggestion = { name, email: `${email.split("@")[0]}@${TYPO_DOMAINS[domain]}` };
    }
  }

  const profile = profileForEmail(profiles, email);
  if (!name) {
    add("warn", "no-name", "Kein Anzeigename — es steht nur die Adresse da.");
    if (profile?.preferredName) suggestion = { name: profile.preferredName, email };
  } else if (nameIsEmailish(name, email)) {
    add("warn", "name-is-email", "Der „Name“ ist nur die Adresse in anderer Form.");
    if (profile?.preferredName) suggestion = { name: profile.preferredName, email };
  } else if (profile) {
    const known = profileNames(profile).some((n) => sameName(n, name));
    if (!known) {
      add("error", "name-mismatch", `„${name}“ gehört nicht zu ${email} (erwartet: „${profile.preferredName}“).`);
      suggestion = { name: profile.preferredName, email };
    } else if (profile.preferredName && normalizeName(profile.preferredName) !== normalizeName(name)) {
      add("info", "name-variant", `Schreibweise weicht ab (bevorzugt: „${profile.preferredName}“).`);
      suggestion = { name: profile.preferredName, email };
    }
  } else if (email) {
    add("info", "unknown-address", "Adresse gehört zu keinem hinterlegten Profil.");
  }

  const hasProblem = findings.some((f) => f.level !== "info");
  return { name, email, findings, suggestion, ok: !hasProblem };
}

/** Prüft einen ganzen Header-Wert (Adressliste). */
export function checkRecipientList(headerValue, profiles = []) {
  const list = parseAddressList(headerValue);
  const results = list.map((r) => checkRecipient(r, profiles));
  return {
    list,
    results,
    ok: results.every((r) => r.ok) && list.length > 0,
    empty: list.length === 0,
  };
}

/** Wendet alle Vorschläge an und liefert den fertigen Header-Wert. */
export function applySuggestions(headerValue, profiles = []) {
  const { list, results } = checkRecipientList(headerValue, profiles);
  const fixed = list.map((r, i) => results[i].suggestion || r);
  return formatAddressList(fixed);
}

/**
 * Baut Profil-Vorschläge aus vorhandenen Adressen (Adressbuch, alte Mails).
 * Gleiche Adresse mit mehreren Namen → häufigster Name gewinnt.
 */
export function deriveProfiles(pairs) {
  const byEmail = new Map();
  for (const { name, email } of pairs || []) {
    const e = normalizeEmail(email);
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, new Map());
    const n = String(name || "").trim();
    if (!n) continue;
    const m = byEmail.get(e);
    m.set(n, (m.get(n) || 0) + 1);
  }
  return [...byEmail.entries()].map(([email, names]) => {
    const sorted = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return {
      id: email,
      label: email,
      preferredName: sorted[0] || "",
      names: sorted.slice(1),
      emails: [email],
    };
  });
}
