import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  looksLikeHtml,
  stripWordCruft,
  splitHistory,
  bodyInner,
  resolveImages,
  buildReaderDocument,
} from "../lib/htmlmail.js";

const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<!--[if !mso]><style>v\\:* {behavior:url(#default#VML);}</style><![endif]-->
<style><!-- p.MsoNormal {margin:0cm; mso-style-priority:99;} --></style>
</head>
<body lang="DE" style="word-wrap:break-word">
<div class="WordSection1">
<p class="MsoNormal"><span style="font-size:10.0pt;font-family:&quot;Arial&quot;;mso-fareast-language:EN-US">Guten Abend,<o:p></o:p></span></p>
<p class="MsoNormal"><a href="mailto:a@b.de">a@b.de</a><o:p></o:p></p>
<p class="MsoNormal"><img border="0" width="1154" height="964" src="cid:image001.png@01D71B1D"><o:p></o:p></p>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">
<p class="MsoNormal"><b>Von:</b> x@y.de<br><b>Gesendet:</b> Montag<br><b>Betreff:</b> Test<o:p></o:p></p>
</div>
<p class="MsoNormal">Alter Text aus der Vorgänger-Mail<o:p></o:p></p>
</div></body></html>`;

test("HTML wird als solches erkannt", () => {
  assert.ok(looksLikeHtml(WORD));
  assert.ok(looksLikeHtml("<p>Hallo</p>"));
  assert.ok(!looksLikeHtml("Preis < 5 und > 3"));
});

test("Word-Ballast fliegt raus, Inhalt bleibt", () => {
  const out = stripWordCruft(bodyInner(WORD));
  assert.ok(!out.includes("mso-"), "keine mso-Deklarationen");
  assert.ok(!/<o:p>/i.test(out), "keine o:p-Marken");
  assert.ok(!/MsoNormal/.test(out), "keine Word-Klassen");
  assert.ok(!/<style/i.test(out), "kein style-Block");
  assert.ok(!/width="1154"/.test(out), "keine Riesenbreite");
  assert.ok(out.includes("Guten Abend,"), "Text erhalten");
  assert.ok(out.includes('href="mailto:a@b.de"'), "Verweise erhalten");
});

test("Skripte und Ereignis-Attribute werden entfernt", () => {
  const evil =
    '<div onclick="alert(1)"><script>alert(2)</script>' +
    '<a href="javascript:alert(3)">klick</a><p onmouseover=\'x()\'>Text</p></div>';
  const out = stripWordCruft(evil);
  assert.ok(!/onclick/i.test(out));
  assert.ok(!/onmouseover/i.test(out));
  assert.ok(!/<script/i.test(out));
  assert.ok(!/javascript:/i.test(out));
  assert.ok(out.includes("Text"));
});

test("zitierter Verlauf wird abgetrennt", () => {
  const { main, history, blocks } = splitHistory(stripWordCruft(bodyInner(WORD)));
  assert.ok(main.includes("Guten Abend,"));
  assert.ok(!main.includes("Alter Text"));
  assert.ok(history.includes("Alter Text"));
  assert.equal(blocks, 1);
});

test("cid-Bilder werden ersetzt, externe blockiert", () => {
  const images = new Map([["image001.png@01D71B1D", "data:image/png;base64,AAAA"]]);
  const withCid = resolveImages('<img src="cid:image001.png@01D71B1D">', images);
  assert.ok(withCid.html.includes("data:image/png;base64,AAAA"));
  assert.equal(withCid.missingCid, 0);

  const missing = resolveImages('<img src="cid:fehlt@x">', new Map());
  assert.equal(missing.missingCid, 1);
  assert.ok(missing.html.includes('data-missing-cid="fehlt@x"'));

  const remote = resolveImages('<img src="https://tracker.example/pixel.gif">');
  assert.equal(remote.blockedRemote, 1);
  assert.ok(remote.html.includes("data-blocked-src"), "als blockiert markiert");
  // Achtung: "data-blocked-src=" enthält selbst "src=" — die Wortgrenze zählt.
  assert.ok(!/(^|\s)src\s*=\s*"https:/i.test(remote.html), "kein ladbares src mehr");
  assert.match(remote.html, /(^|\s)src=""/);
});

test("Lesedokument ist abgeschottet und vollständig", () => {
  const built = buildReaderDocument(WORD);
  assert.match(built.document, /^<!doctype html>/);
  assert.match(built.document, /Content-Security-Policy/);
  assert.match(built.document, /default-src 'none'/);
  assert.ok(built.document.includes("Guten Abend,"));
  assert.equal(built.historyBlocks, 1);
  assert.equal(built.missingCid, 1);
  // Verlauf steckt in einem <details> und ist ohne Skripte aufklappbar
  assert.match(built.document, /<details class="sdm-history"><summary>/);
  assert.ok(built.document.includes("Alter Text"));
});

test("Verlauf kann aufgeklappt vorbelegt werden", () => {
  const open = buildReaderDocument(WORD, { showHistory: true });
  assert.match(open.document, /<details class="sdm-history" open>/);
});

// Echte Word-Mail aus der Praxis, Namen und Anschriften anonymisiert.
test("eine Word-Mail aus der Praxis wird lesbar", () => {
  const raw = readFileSync(
    new URL("./fixtures/word-mail.html", import.meta.url),
    "utf8"
  );
  const built = buildReaderDocument(raw);
  assert.ok(built.document.length < raw.length, "kleiner als das Original");
  assert.equal((built.document.match(/mso-/g) || []).length, 0);
  assert.equal((built.document.match(/<o:p>/g) || []).length, 0);
  assert.ok(built.historyBlocks >= 5, `Verlauf erkannt: ${built.historyBlocks}`);
  assert.equal(built.missingCid, 3, "drei cid-Bilder als Platzhalter");
  assert.ok(built.document.includes("Guten Abend Herr Muster"));
  assert.ok(built.document.includes("Materialbedarf"));
});
