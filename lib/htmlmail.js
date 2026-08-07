// htmlmail.js — HTML-Mails lesbar machen.
//
// Word/Outlook erzeugt HTML mit kiloweise Ballast: `mso-*`-Regeln, leere
// `<o:p>`-Tags, bedingte Kommentare, Klassen wie `MsoNormal`, Bilder mit
// `width="1154"`. Als Text gelesen ist das unbrauchbar; roh gerendert bricht
// es das Layout und lädt womöglich externe Zählpixel. Hier wird beides
// behandelt: aufräumen, und in ein abgeschottetes Dokument verpacken.

const CONDITIONAL = /<!--\[if[\s\S]*?<!\[endif\]-->/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG_BLOCK = (tag) => new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");

/** Erkennt, ob ein Rumpf HTML ist (und nicht nur Text mit spitzen Klammern). */
export function looksLikeHtml(text) {
  const t = String(text || "");
  return /<\s*(html|body|div|p|table|br|span)\b/i.test(t) || /<\/(p|div|span|td)>/i.test(t);
}

/**
 * Entfernt Word-Ballast, ohne die Struktur anzutasten.
 * @returns {string}
 */
export function stripWordCruft(html) {
  let s = String(html || "");
  s = s.replace(CONDITIONAL, "");
  s = s.replace(TAG_BLOCK("style"), "");
  s = s.replace(TAG_BLOCK("script"), "");
  s = s.replace(TAG_BLOCK("xml"), "");
  s = s.replace(COMMENT, "");
  // leere Word-Absatzmarken
  s = s.replace(/<\/?o:p\s*\/?>/gi, "");
  s = s.replace(/<\/?[a-z]+:[a-z-]+[^>]*>/gi, "");
  // Ereignis-Attribute und javascript:-Ziele
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
  // Word-Klassen und XML-Namensräume
  s = s.replace(/\sclass\s*=\s*("|')[^"']*\1/gi, "");
  s = s.replace(/\sxmlns(:[a-z]+)?\s*=\s*("|')[^"']*\2/gi, "");
  s = s.replace(/\slang\s*=\s*("|')[^"']*\1/gi, "");
  // mso-Deklarationen aus verbliebenen style-Attributen
  s = s.replace(/style\s*=\s*"([^"]*)"/gi, (_m, decls) => {
    const kept = decls
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d && !/^mso-/i.test(d) && !/^page:/i.test(d))
      .join("; ");
    return kept ? `style="${kept}"` : "";
  });
  // Riesenbilder aus Word bändigen
  s = s.replace(/\s(width|height)\s*=\s*("|')?\d+\2?/gi, "");
  return s;
}

/**
 * Trennt den eigentlichen Text vom zitierten Verlauf.
 * Word/Outlook setzt vor jeden zitierten Block eine dünne Linie und einen
 * „Von:/Gesendet:/An:"-Kopf — daran lässt sich sauber schneiden.
 * @returns {{main:string, history:string, blocks:number}}
 */
export function splitHistory(html) {
  const s = String(html || "");
  const markers = [
    /<div[^>]*border-top\s*:\s*solid[^>]*>/i,
    /<b>\s*Von\s*:\s*<\/b>/i,
    /<b>\s*From\s*:\s*<\/b>/i,
    /<blockquote/i,
  ];
  let cut = -1;
  for (const re of markers) {
    const m = re.exec(s);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut < 0) return { main: s, history: "", blocks: 0 };
  const history = s.slice(cut);
  const blocks = (history.match(/<b>\s*(Von|From)\s*:\s*<\/b>/gi) || []).length;
  return { main: s.slice(0, cut), history, blocks };
}

/** Zieht den Inhalt von <body> heraus, falls ein ganzes Dokument vorliegt. */
export function bodyInner(html) {
  const s = String(html || "");
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  return m ? m[1] : s;
}

/** cid:-Verweise auf mitgelieferte Bilder umbiegen; Rest neutralisieren. */
export function resolveImages(html, images = new Map(), { allowRemote = false } = {}) {
  let blockedRemote = 0;
  let missingCid = 0;
  const s = String(html || "").replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)("|')(.*?)\2/gi,
    (full, head, q, url) => {
      const u = String(url).trim();
      if (/^cid:/i.test(u)) {
        const cid = u.slice(4).replace(/^<|>$/g, "");
        const found = images.get(cid) || images.get(decodeURIComponent(cid));
        if (found) return `${head}${q}${found}${q}`;
        missingCid++;
        return `${head}${q}${q} data-missing-cid="${cid}"`;
      }
      if (/^data:image\//i.test(u)) return full;
      if (!allowRemote) {
        blockedRemote++;
        return `${head}${q}${q} data-blocked-src="${u.replace(/"/g, "")}"`;
      }
      return full;
    }
  );
  return { html: s, blockedRemote, missingCid };
}

const READER_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; max-width: 100%; }
body {
  margin: 0;
  padding: 18px 20px;
  background: #fff;
  color: #111;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow-wrap: anywhere;
}
p { margin: 0 0 10px; }
p:empty { display: none; }
a { color: #0b57d0; }
ul, ol { margin: 0 0 10px; padding-left: 24px; }
li { margin: 0 0 4px; }
img { height: auto; border-radius: 4px; }
img[data-blocked-src], img[data-missing-cid] {
  display: inline-block;
  min-width: 160px;
  min-height: 28px;
  border: 1px dashed #bbb;
  border-radius: 6px;
  background: #f5f5f5;
  position: relative;
}
img[data-blocked-src]::after { content: "Externes Bild blockiert"; }
img[data-missing-cid]::after { content: "Bild nicht in dieser Nachricht"; }
img[data-blocked-src]::after, img[data-missing-cid]::after {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-size: 12px; color: #777;
}
table { border-collapse: collapse; }
td, th { padding: 4px 8px; vertical-align: top; }
blockquote {
  margin: 0 0 10px; padding: 0 0 0 12px;
  border-left: 3px solid #d5d5d5; color: #444;
}
.sdm-history {
  margin-top: 18px; padding-top: 12px;
  border-top: 1px solid #ddd; color: #444;
}
.sdm-history > summary {
  cursor: pointer; font-size: 12.5px; color: #777;
  padding: 4px 0; list-style: revert;
}
.sdm-history-body { margin-top: 10px; }
.sdm-history-body p { color: #444; }
`;

/**
 * Baut ein vollständiges, abgeschottetes Dokument für die Anzeige im iframe.
 *
 * Sicherheit: Das Dokument trägt eine eigene CSP (`default-src 'none'`), das
 * iframe läuft ohne `allow-scripts`. Selbst wenn beim Aufräumen etwas
 * durchrutscht, kann nichts ausgeführt und nichts nachgeladen werden.
 *
 * @param {string} html Roh-HTML der Mail
 * @param {{images?:Map, showHistory?:boolean, allowRemote?:boolean}} opts
 * @returns {{document:string, blockedRemote:number, missingCid:number, historyBlocks:number}}
 */
export function buildReaderDocument(html, opts = {}) {
  const { images = new Map(), showHistory = false, allowRemote = false } = opts;
  const cleaned = stripWordCruft(bodyInner(html));
  const { main, history, blocks } = splitHistory(cleaned);

  const mainPart = resolveImages(main, images, { allowRemote });
  const histPart = history
    ? resolveImages(history, images, { allowRemote })
    : { html: "", blockedRemote: 0, missingCid: 0 };

  let content = mainPart.html;
  if (history) {
    // <details> statt Umschalt-Knopf: Das Dokument läuft ohne Skripte, der
    // Verlauf muss sich trotzdem auf- und zuklappen lassen.
    content +=
      `<details class="sdm-history"${showHistory ? " open" : ""}>` +
      `<summary>${blocks || 1} zitierte ältere Nachricht(en)</summary>` +
      `<div class="sdm-history-body">${histPart.html}</div></details>`;
  }

  const csp =
    "default-src 'none'; img-src data: blob: cid:; style-src 'unsafe-inline'; font-src data:";
  const doc =
    `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${READER_CSS}</style></head><body>${content}</body></html>`;

  return {
    document: doc,
    blockedRemote: mainPart.blockedRemote + histPart.blockedRemote,
    missingCid: mainPart.missingCid + histPart.missingCid,
    historyBlocks: blocks,
  };
}
