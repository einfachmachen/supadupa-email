// attachments.js — Prüfung der Anhänge: Was hängt dran, und heißt es plausibel?

import { extractFacts } from "./similarity.js";

const EXT_BY_TYPE = {
  "application/pdf": ["pdf"],
  "application/xml": ["xml"],
  "text/xml": ["xml"],
  "text/csv": ["csv"],
  "text/plain": ["txt", "asc", "csv"],
  "text/html": ["html", "htm"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/heic": ["heic"],
  "application/zip": ["zip"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
};

/** Namen, die nichts über den Inhalt aussagen. */
const GENERIC_PATTERNS = [
  /^(unbenannt|unnamed|attachment|anhang|dokument|document|datei|file|scan|scan_?bild|image|img|foto|photo|bild)[ _-]?\d*$/i,
  /^att\d+$/i,
  /^(image|img|bild)\d{3,}$/i,
  /^(dokument|document)\d*$/i,
  /^scan[ _-]?\d*$/i,
  /^\d{1,4}$/,
  /^(neu|new|kopie|copy|final|final\d*|test)$/i,
];

/** Endungen, die in einer Finanz-Mail selten harmlos sind. */
const RISKY_EXT = [
  "exe", "scr", "com", "pif", "bat", "cmd", "js", "jse", "vbs", "vbe",
  "wsf", "wsh", "jar", "msi", "lnk", "ps1", "hta", "iso", "img", "docm", "xlsm",
];

export function splitName(name) {
  const n = String(name || "").trim();
  const i = n.lastIndexOf(".");
  if (i <= 0) return { base: n, ext: "" };
  return { base: n.slice(0, i), ext: n.slice(i + 1).toLowerCase() };
}

function normBase(base) {
  return base
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ziffernfolgen aus einem Dateinamen, zum Abgleich mit Beleg-/Rechnungsnummern. */
function digitsOf(s) {
  return (String(s).match(/\d{2,}/g) || []);
}

/**
 * Prüft einen einzelnen Anhang.
 * @param {{name:string,contentType:string,size:number,partName?:string}} att
 * @param {{subject?:string, body?:string}} ctx Kontext der Mail
 * @returns {{name:string, findings:Array<{level:"info"|"warn"|"error", code:string, text:string}>, plausible:boolean}}
 */
export function checkAttachment(att, ctx = {}) {
  const findings = [];
  const name = String(att?.name || "").trim();
  const { base, ext } = splitName(name);
  const type = String(att?.contentType || "").toLowerCase().split(";")[0].trim();
  const size = Number(att?.size ?? 0);

  const add = (level, code, text) => findings.push({ level, code, text });

  if (!name) {
    add("error", "no-name", "Anhang ohne Dateinamen.");
  } else {
    if (!ext) add("warn", "no-ext", "Dateiname ohne Endung — Empfänger können ihn evtl. nicht öffnen.");
    if (GENERIC_PATTERNS.some((re) => re.test(normBase(base).replace(/\s/g, ""))) ||
        GENERIC_PATTERNS.some((re) => re.test(base))) {
      add("warn", "generic-name", `„${base}“ ist ein nichtssagender Name.`);
    }
    if (name.length > 100) add("warn", "long-name", "Sehr langer Dateiname (> 100 Zeichen).");
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f<>:"/\\|?*]/.test(name)) {
      add("warn", "bad-chars", "Enthält Zeichen, die auf manchen Systemen nicht erlaubt sind.");
    }
    if (/\.(pdf|docx?|xlsx?|jpe?g|png)\.[a-z0-9]{2,4}$/i.test(name)) {
      add("error", "double-ext", "Doppelte Endung — klassisches Tarnmuster.");
    }
    if (RISKY_EXT.includes(ext)) {
      add("error", "risky-ext", `Endung .${ext} ist ausführbar bzw. makrofähig.`);
    }
    const allowed = EXT_BY_TYPE[type];
    if (allowed && ext && !allowed.includes(ext)) {
      add("warn", "type-mismatch", `Endung .${ext} passt nicht zum Typ ${type}.`);
    }
  }

  if (size === 0) add("error", "empty", "Anhang ist 0 Byte groß.");
  else if (size > 0 && size < 1024) add("info", "tiny", "Sehr kleiner Anhang (< 1 KB).");

  // Bezug zum Mail-Inhalt: taucht Beleg-/Rechnungsnummer oder Datum im Namen auf?
  const facts = extractFacts(`${ctx.subject || ""}\n${ctx.body || ""}`);
  const nameDigits = digitsOf(base);
  const refHit =
    facts.docNumbers.some((d) => base.toLowerCase().includes(String(d).toLowerCase())) ||
    facts.docNumbers.some((d) => digitsOf(d).some((x) => nameDigits.includes(x)));
  if (facts.docNumbers.length && !refHit) {
    add("info", "no-ref", `Im Text steht ${facts.docNumbers.slice(0, 2).join(", ")} — im Dateinamen nicht.`);
  }

  const subjWords = normBase((ctx.subject || "").toLowerCase()).split(" ").filter((w) => w.length > 3);
  const baseNorm = normBase(base).toLowerCase();
  const subjHit = subjWords.some((w) => baseNorm.includes(w));
  if (name && !subjHit && !refHit && subjWords.length) {
    add("info", "no-subject-ref", "Kein erkennbarer Bezug zum Betreff.");
  }

  return {
    name,
    contentType: type,
    size,
    findings,
    plausible: !findings.some((f) => f.level === "error" || f.level === "warn"),
  };
}

/** Prüft alle Anhänge einer Mail plus Aussagen über die Menge. */
export function checkAttachments(list, ctx = {}) {
  const items = (list || []).map((a) => checkAttachment(a, ctx));
  const findings = [];
  const text = `${ctx.subject || ""}\n${ctx.body || ""}`;
  const announced =
    /\b(anbei|beiliegend|im anhang|als anhang|anhängend|attached|beigefügt|anlage[n]?)\b/i.test(text);
  if (announced && items.length === 0) {
    findings.push({
      level: "error",
      code: "announced-missing",
      text: "Der Text kündigt einen Anhang an — es hängt aber keiner dran.",
    });
  }
  if (!announced && items.length > 0) {
    findings.push({
      level: "info",
      code: "unannounced",
      text: "Anhang vorhanden, im Text aber nicht erwähnt.",
    });
  }
  const names = items.map((i) => i.name.toLowerCase()).filter(Boolean);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) {
    findings.push({
      level: "warn",
      code: "duplicate-names",
      text: `Mehrfach gleicher Dateiname: ${[...new Set(dupes)].join(", ")}.`,
    });
  }
  return { items, findings };
}

/** Vorschlag für einen sprechenden Dateinamen aus Betreff/Fakten. */
export function suggestName(att, ctx = {}) {
  const { ext } = splitName(att?.name || "");
  const facts = extractFacts(`${ctx.subject || ""}\n${ctx.body || ""}`);
  const parts = [];
  const d = (ctx.date instanceof Date ? ctx.date : new Date(ctx.date || Date.now()));
  if (!Number.isNaN(d.valueOf())) {
    parts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  const subj = normBase(String(ctx.subject || "").replace(/^(re|aw|fwd?|wg)\s*:\s*/gi, ""))
    .split(" ")
    .slice(0, 5)
    .join("-");
  if (subj) parts.push(subj);
  if (facts.docNumbers[0]) parts.push(String(facts.docNumbers[0]).replace(/[^\w-]/g, ""));
  const base = parts.join("_").replace(/[^\w.-]/g, "-").replace(/-+/g, "-");
  return ext ? `${base}.${ext}` : base;
}
