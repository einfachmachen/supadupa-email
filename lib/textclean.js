// textclean.js — Steuer- und Sonderzeichen aus E-Mail-Text entfernen.
//
// Warum das die Erkennung überhaupt betrifft: Zwei Kopien derselben Mail
// unterscheiden sich oft NUR durch solchen unsichtbaren Müll (ein Gateway hat
// Zero-Width-Zeichen eingestreut, ein Konverter hat NBSP statt Leerzeichen
// gesetzt, ein Export hat C0-Steuerzeichen stehen lassen). Ohne Säuberung
// wären das zwei verschiedene Prüfsummen — die Mails würden nie als
// zusammengehörig erkannt. Deshalb läuft JEDER Textvergleich über cleanText().

/** Unsichtbare bzw. bedeutungslose Zeichen, gruppiert für die Meldung. */
const CLASSES = [
  {
    code: "c0",
    label: "Steuerzeichen (C0)",
    // alles unter 0x20 außer Tab/LF/CR, plus DEL und C1-Bereich
    // eslint-disable-next-line no-control-regex
    re: /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,
    replace: "",
  },
  {
    code: "zerowidth",
    label: "Zero-Width-Zeichen",
    re: /[\u200b-\u200d\u2060\ufeff]/g,
    replace: "",
  },
  {
    code: "bidi",
    label: "Schreibrichtungs-Marken",
    re: /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    replace: "",
  },
  {
    code: "softhyphen",
    label: "bedingte Trennstriche",
    re: /\u00ad/g,
    replace: "",
  },
  {
    code: "nbsp",
    label: "geschützte Leerzeichen",
    re: /[\u00a0\u2007\u202f\u2000-\u200a\u205f\u3000]/g,
    replace: " ",
  },
  {
    code: "replacement",
    label: "Ersatzzeichen (kaputte Kodierung)",
    re: /\ufffd/g,
    replace: "",
  },
  {
    code: "qp-artifact",
    label: "Quoted-Printable-Reste",
    // "=20" o. Ä. am Zeilenende, das kein Decoder aufgelöst hat
    re: /=(?:20|0D|0A|09)(?=\r?\n|$)/gi,
    replace: "",
  },
  {
    code: "softbreak",
    label: "weiche Zeilenumbrüche (=\\n)",
    // Nur ein einzelnes "=" am Zeilenende — eine Trennlinie aus "=====" ist
    // keine Quoted-Printable-Fortsetzung und bleibt unangetastet.
    re: /(?<![=])=\r?\n/g,
    replace: "",
  },
];

/**
 * Säubert Text und meldet, was gefunden wurde.
 * @returns {{text:string, findings:Array<{code,label,count}>}}
 */
export function cleanText(input) {
  let text = String(input ?? "");
  const findings = [];
  for (const c of CLASSES) {
    const matches = text.match(c.re);
    if (matches?.length) {
      findings.push({ code: c.code, label: c.label, count: matches.length });
      text = text.replace(c.re, c.replace);
    }
  }
  // Rahmen aus Sonderzeichen, die manche Systeme um den Text legen
  const framed = text.replace(/^[\s*=~_#|+-]{6,}$/gm, "");
  if (framed !== text) {
    findings.push({ code: "frame", label: "Trennlinien-Rahmen", count: 1 });
    text = framed;
  }
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, findings };
}

/** Nur der gesäuberte Text. */
export function clean(input) {
  return cleanText(input).text;
}

/** Enthält der Text Zeichen, die dort nichts zu suchen haben? */
export function hasJunk(input) {
  return cleanText(input).findings.length > 0;
}

/** Menschenlesbare Zusammenfassung für die Oberfläche. */
export function describeJunk(input) {
  const { findings } = cleanText(input);
  if (!findings.length) return "";
  return findings.map((f) => `${f.count}× ${f.label}`).join(", ");
}

/**
 * Macht unsichtbaren Müll sichtbar — für den Modus „Original“, in dem man
 * sehen will, WAS eigentlich im Text steckt, statt es nur gemeldet zu bekommen.
 */
export function visualize(input) {
  return String(input ?? "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "\u2337")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\u21c4")
    .replace(/\u00ad/g, "\u00ac")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, "\u2423")
    .replace(/\ufffd/g, "\u25c6")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "\u2426");
}

/**
 * Vergleichsform: gesäubert, klein, ohne Leerraum-Unterschiede.
 * Das ist die Grundlage der Inhalts-Prüfsumme.
 */
export function comparable(input) {
  return clean(input)
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}
