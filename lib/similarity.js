// similarity.js — inhaltlicher Vergleich von E-Mail-Texten.
//
// Ziel ist nicht "identisch ja/nein", sondern eine belastbare Aussage darüber,
// ob zwei Mails denselben Inhalt tragen, obwohl Kopfdaten abweichen.

/** Zitierte Zeilen, Signaturen und Weiterleitungs-Vorspann entfernen. */
export function stripQuotes(text) {
  const lines = String(text || "").split(/\r?\n/);
  const keep = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^--\s*$/.test(line)) break; // Signatur-Trenner
    if (/^-{3,}\s*(Weitergeleitete|Original|Forwarded|Original Message)/i.test(line)) break;
    if (/^(Von|From|Gesendet|Sent|An|To|Betreff|Subject):\s/i.test(line) && keep.length === 0) continue;
    keep.push(line);
  }
  return keep.join("\n");
}

/** HTML → Text (grob, aber ausreichend für den Vergleich). */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Vergleichsform: Kleinschreibung, ohne Satzzeichen, ohne Mehrfach-Leerraum. */
export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ /g, " ")
    .replace(/[‐-―−]/g, "-")
    .replace(/[„“”»«]/g, '"')
    .replace(/[^\p{L}\p{N}\s.,:@€%-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text) {
  const n = normalize(text);
  return n ? n.split(" ").filter((t) => t.length > 1) : [];
}

/** Wort-Bigramme („Shingles“) — robuster gegen umgestellte Absätze. */
function shingles(tokens, n = 2) {
  if (tokens.length < n) return new Set(tokens);
  const s = new Set();
  for (let i = 0; i <= tokens.length - n; i++) s.add(tokens.slice(i, i + n).join(" "));
  return s;
}

function dice(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/**
 * Vergleicht zwei Texte und liefert
 * { score, tokenScore, shingleScore, onlyA, onlyB } — score in [0,1].
 */
export function compareTexts(a, b) {
  const ta = tokenize(stripQuotes(a));
  const tb = tokenize(stripQuotes(b));
  const sa = new Set(ta);
  const sb = new Set(tb);
  const tokenScore = dice(sa, sb);
  const shingleScore = dice(shingles(ta), shingles(tb));
  const onlyA = [...sa].filter((t) => !sb.has(t));
  const onlyB = [...sb].filter((t) => !sa.has(t));
  return {
    score: 0.4 * tokenScore + 0.6 * shingleScore,
    tokenScore,
    shingleScore,
    onlyA,
    onlyB,
  };
}

/** Einstufung für die Anzeige. */
export function classify(score) {
  if (score >= 0.98) return { key: "identisch", label: "inhaltlich identisch" };
  if (score >= 0.85) return { key: "nahezu", label: "nahezu gleich" };
  if (score >= 0.55) return { key: "aehnlich", label: "ähnlich" };
  return { key: "verschieden", label: "unterschiedlich" };
}

const RE_IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;
const RE_AMOUNT = /(?<![\d.,])\d{1,3}(?:\.\d{3})*,\d{2}\s?(?:€|EUR)(?![\w])|(?<![\d.,])\d+,\d{2}\s?(?:€|EUR)(?![\w])/g;
const RE_DATE = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/g;
const RE_DOCNO =
  /\b(?:rechnung|rg|re|beleg|invoice|auftrag|kunden|vertrag|bestell)[-\s.]?(?:nr\.?|nummer|no\.?)?[-\s:.]?([A-Z0-9][A-Z0-9/-]{2,})/gi;

/**
 * Zieht die für ein Finanz-Dokument kennzeichnenden Angaben aus dem Text.
 * Wird sowohl für den Inhaltsvergleich als auch für die Dateinamen-Prüfung
 * genutzt (§ Anhänge).
 */
export function extractFacts(text) {
  const t = String(text || "");
  const uniq = (arr) => [...new Set(arr)];
  return {
    amounts: uniq((t.match(RE_AMOUNT) || []).map((s) => s.trim())),
    ibans: uniq((t.match(RE_IBAN) || []).map((s) => s.replace(/\s/g, ""))),
    dates: uniq(t.match(RE_DATE) || []),
    docNumbers: uniq(
      [...t.matchAll(RE_DOCNO)].map((m) => m[1]).filter((s) => /\d/.test(s))
    ),
  };
}

/** Vergleicht die Fakten zweier Mails — Abweichungen sind das Interessante. */
export function compareFacts(a, b) {
  const fa = extractFacts(a);
  const fb = extractFacts(b);
  const diff = {};
  for (const key of Object.keys(fa)) {
    const setB = new Set(fb[key]);
    const setA = new Set(fa[key]);
    const onlyA = fa[key].filter((v) => !setB.has(v));
    const onlyB = fb[key].filter((v) => !setA.has(v));
    if (onlyA.length || onlyB.length) diff[key] = { onlyA, onlyB };
  }
  return { factsA: fa, factsB: fb, diff, equal: Object.keys(diff).length === 0 };
}
