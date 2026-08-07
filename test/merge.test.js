import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listParts,
  listAttachmentParts,
  setPartFilenames,
  getParam,
  encodeFilenameParams,
} from "../lib/mimeparts.js";
import { stringToBytes, decodeLatin1, getHeader, splitMessage, setHeader } from "../lib/rawmail.js";
import {
  buildMergePlan,
  pickBase,
  bestRecipients,
  donorNames,
  planRenames,
  recipientScore,
  unionAddresses,
} from "../lib/merge.js";
import { contentKey, verifyGroup, groupDuplicates, normalizeBody } from "../lib/dedupe.js";

const CRLF = "\r\n";
const B64 = "JVBERi0xLjQKJSVFT0Y=";

/** Beispielnachricht mit zwei Anhängen, einer davon ohne Dateinamen. */
function sample({ to = "max@example.de", name1 = "ATT00001.pdf", withName2 = true } = {}) {
  return [
    "From: Firma <buchhaltung@firma.de>",
    `To: ${to}`,
    "Subject: Rechnung 2024-0815",
    "Message-ID: <abc@firma.de>",
    'Content-Type: multipart/mixed; boundary="GRENZE"',
    "",
    "--GRENZE",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Guten Tag, anbei die Rechnung 2024-0815 über 1.234,56 €.",
    "--GRENZE",
    `Content-Type: application/pdf; name="${name1}"`,
    `Content-Disposition: attachment; filename="${name1}"`,
    "Content-Transfer-Encoding: base64",
    "",
    B64,
    "--GRENZE",
    "Content-Type: application/pdf" + (withName2 ? '; name="Anlage.pdf"' : ""),
    withName2 ? "Content-Disposition: attachment; filename=\"Anlage.pdf\"" : "Content-Disposition: attachment",
    "Content-Transfer-Encoding: base64",
    "",
    B64,
    "--GRENZE--",
    "",
  ].join(CRLF);
}

// ------------------------------------------------------------- MIME-Struktur

test("MIME-Teile werden mit Anhängen erkannt", () => {
  const parts = listParts(stringToBytes(sample()));
  assert.equal(parts[0].contentType, "multipart/mixed");
  assert.equal(parts.length, 4, JSON.stringify(parts.map((p) => p.contentType)));
  const atts = listAttachmentParts(stringToBytes(sample()));
  assert.equal(atts.length, 2);
  assert.equal(atts[0].filename, "ATT00001.pdf");
  assert.equal(atts[1].filename, "Anlage.pdf");
});

test("Parameter lesen inkl. RFC 2231", () => {
  assert.equal(getParam('application/pdf; name="a b.pdf"', "name"), "a b.pdf");
  assert.equal(getParam("attachment; filename*=UTF-8''Rechnung%20M%C3%BCller.pdf", "filename"), "Rechnung Müller.pdf");
  assert.equal(getParam('multipart/mixed; boundary="X-Y"', "boundary"), "X-Y");
});

test("Dateinamen kodieren: ASCII schlicht, Umlaut nach RFC 2231", () => {
  assert.equal(encodeFilenameParams("Rechnung.pdf"), 'filename="Rechnung.pdf"');
  const enc = encodeFilenameParams("Rechnung Müller.pdf");
  assert.match(enc, /filename="Rechnung Muller\.pdf"/);
  assert.match(enc, /filename\*=UTF-8''Rechnung%20M%C3%BCller\.pdf/);
  assert.equal(getParam(enc, "filename"), "Rechnung Müller.pdf");
});

test("Umbenennen ändert nur die Kopfzeilen, nie die Nutzdaten", () => {
  const bytes = stringToBytes(sample());
  const atts = listAttachmentParts(bytes);
  const out = setPartFilenames(bytes, [
    { index: atts[0].index, filename: "2024-04-03_Rechnung-2024-0815.pdf" },
    { index: atts[1].index, filename: "Anlage_2024-0815.pdf" },
  ]);
  const text = decodeLatin1(out);
  assert.equal((text.match(new RegExp(B64, "g")) || []).length, 2, "Nutzdaten unverändert");
  assert.ok(!text.includes("ATT00001.pdf"));
  const after = listAttachmentParts(out);
  assert.equal(after[0].filename, "2024-04-03_Rechnung-2024-0815.pdf");
  assert.equal(after[1].filename, "Anlage_2024-0815.pdf");
  assert.equal(getHeader(splitMessage(out).headerText, "Subject"), "Rechnung 2024-0815");
});

test("Anhang ohne Namen bekommt Content-Disposition mit Dateinamen", () => {
  const bytes = stringToBytes(sample({ withName2: false }));
  const atts = listAttachmentParts(bytes);
  assert.equal(atts.length, 2);
  assert.equal(atts[1].filename, "");
  const out = setPartFilenames(bytes, [{ index: atts[1].index, filename: "Beleg.pdf" }]);
  assert.equal(listAttachmentParts(out)[1].filename, "Beleg.pdf");
  assert.ok(decodeLatin1(out).includes(B64));
});

test("Umlaut-Dateiname übersteht den Round-Trip", () => {
  const bytes = stringToBytes(sample());
  const atts = listAttachmentParts(bytes);
  const out = setPartFilenames(bytes, [{ index: atts[0].index, filename: "Rechnung Jörg.pdf" }]);
  assert.equal(listAttachmentParts(out)[0].filename, "Rechnung Jörg.pdf");
});

test("Header- und Anhang-Änderung zusammen bleiben verträglich", () => {
  let bytes = stringToBytes(sample({ to: "max@example.de" }));
  bytes = setHeader(bytes, "To", "Max Mustermann <max@example.de>");
  const atts = listAttachmentParts(bytes);
  bytes = setPartFilenames(bytes, [{ index: atts[0].index, filename: "Rechnung.pdf" }]);
  assert.equal(getHeader(splitMessage(bytes).headerText, "To"), "Max Mustermann <max@example.de>");
  assert.equal(listAttachmentParts(bytes)[0].filename, "Rechnung.pdf");
  assert.equal((decodeLatin1(bytes).match(new RegExp(B64, "g")) || []).length, 2);
});

// ------------------------------------------------------------- Zusammenführen

const PROFILES = [
  { id: "1", preferredName: "Max Mustermann", names: [], emails: ["max@example.de"] },
];
const CTX = {
  subject: "Rechnung 2024-0815",
  body: "anbei die Rechnung 2024-0815 über 1.234,56 €",
  date: "2024-04-03T10:00:00Z",
};

const copyA = {
  id: 1, // vollständige Anhänge, aber Empfänger nur als Adresse
  to: "max@example.de",
  cc: "",
  size: 90000,
  attachments: [
    { name: "ATT00001.pdf", contentType: "application/pdf", size: 5000 },
    { name: "", contentType: "application/pdf", size: 7000 },
  ],
};
const copyB = {
  id: 2, // guter Empfänger + guter Dateiname, aber nur ein Anhang
  to: "Max Mustermann <max@example.de>",
  cc: "",
  size: 40000,
  attachments: [{ name: "Rechnung_2024-0815.pdf", contentType: "application/pdf", size: 5000 }],
};
const copyC = {
  id: 3, // gar kein Empfänger
  to: "",
  cc: "",
  size: 30000,
  attachments: [],
};

test("Grundlage ist die Kopie mit den vollständigsten Anhängen", () => {
  assert.equal(pickBase([copyA, copyB, copyC]).id, 1);
});

test("beste Empfänger-Zeile kommt aus der Kopie, die sie hat", () => {
  const best = bestRecipients([copyA, copyB, copyC], PROFILES, "to");
  assert.equal(best.fromId, 2);
  assert.equal(best.value, "Max Mustermann <max@example.de>");
  assert.ok(recipientScore(copyB.to, PROFILES) > recipientScore(copyA.to, PROFILES));
  assert.ok(recipientScore(copyC.to, PROFILES) < 0);
});

test("fehlender Name wird über das Profil ergänzt, wenn keine Kopie ihn hat", () => {
  const best = bestRecipients([copyA, copyC], PROFILES, "to");
  assert.equal(best.value, "Max Mustermann <max@example.de>");
  assert.ok(best.corrected);
});

test("guter Dateiname wandert von der einen Kopie auf die Grundlage", () => {
  const donors = donorNames([copyA, copyB], CTX);
  const parts = [
    { index: 1, filename: "ATT00001.pdf", contentType: "application/pdf", size: 5000 },
    { index: 2, filename: "", contentType: "application/pdf", size: 7000 },
  ];
  const renames = planRenames(parts, CTX, donors);
  assert.equal(renames.length, 2);
  assert.equal(renames[0].filename, "Rechnung_2024-0815.pdf");
  assert.match(renames[0].reason, /andere/i);
  // Für den namenlosen Anhang gibt es keinen Spender → Vorschlag aus dem Inhalt
  assert.match(renames[1].filename, /^2024-04-03_/);
  assert.match(renames[1].filename, /\.pdf$/);
});

test("plausible Namen werden nicht angefasst", () => {
  const parts = [
    { index: 1, filename: "Rechnung_2024-0815.pdf", contentType: "application/pdf", size: 5000 },
  ];
  assert.deepEqual(planRenames(parts, CTX, donorNames([copyB], CTX)), []);
});

test("Namenskollisionen werden durchnummeriert", () => {
  const parts = [
    { index: 1, filename: "", contentType: "application/pdf", size: 1 },
    { index: 2, filename: "", contentType: "application/pdf", size: 2 },
  ];
  const renames = planRenames(parts, CTX, new Map());
  assert.equal(renames.length, 2);
  assert.notEqual(renames[0].filename, renames[1].filename);
  assert.match(renames[1].filename, /-2\.pdf$/);
});

test("vollständiger Plan bündelt Empfänger und Umbenennungen", () => {
  const baseParts = [
    { index: 1, filename: "ATT00001.pdf", contentType: "application/pdf", size: 5000 },
    { index: 2, filename: "", contentType: "application/pdf", size: 7000 },
  ];
  const plan = buildMergePlan({
    copies: [copyA, copyB, copyC],
    profiles: PROFILES,
    baseParts,
    ctx: CTX,
  });
  assert.equal(plan.baseId, 1);
  assert.equal(plan.headers.To, "Max Mustermann <max@example.de>");
  assert.equal(plan.renames.length, 2);
  assert.deepEqual(plan.removableIds.sort(), [1, 2, 3]);
  assert.ok(plan.complete);
  assert.ok(plan.notes.some((n) => n.includes("Kopie 2")));
});

test("Plan meldet, wenn keine Kopie einen Empfänger hat", () => {
  const plan = buildMergePlan({
    copies: [{ ...copyC, id: 9 }],
    profiles: [],
    baseParts: [],
    ctx: CTX,
  });
  assert.ok(!plan.complete);
  assert.ok(plan.notes.some((n) => n.startsWith("ACHTUNG")));
  assert.deepEqual(plan.headers, {});
});

test("Adressen vereinen behält den vollständigeren Eintrag", () => {
  assert.equal(
    unionAddresses("max@example.de", "Max Mustermann <max@example.de>, Eva <e@f.de>"),
    "Max Mustermann <max@example.de>, Eva <e@f.de>"
  );
});

// --------------------------------------------------------- Inhalts-Prüfsumme

test("Prüfsumme ignoriert Empfänger und Dateinamen, nicht den Inhalt", () => {
  const a = {
    bodyText: "Guten Tag,\r\n\r\nanbei die Rechnung.",
    attachments: [{ size: 5000, contentType: "application/pdf" }],
  };
  const b = {
    bodyText: "Guten Tag,\n anbei  die Rechnung.",
    attachments: [{ size: 5000, contentType: "application/pdf" }],
  };
  const c = { ...a, bodyText: "Guten Tag,\n\nanbei die MAHNUNG." };
  const d = { ...a, attachments: [{ size: 6000, contentType: "application/pdf" }] };
  assert.equal(contentKey(a), contentKey(b));
  assert.notEqual(contentKey(a), contentKey(c));
  assert.notEqual(contentKey(a), contentKey(d));
  assert.equal(normalizeBody("A  B\r\n\r\nC"), "a b\nc");
});

test("Verifikation trennt zufällig gleich betitelte Mails auf", () => {
  const base = { subject: "Rechnung", author: "F <f@x.de>", date: "2024-04-03T10:00:00Z", size: 10 };
  const headers = [
    { ...base, id: 1, headerMessageId: "" },
    { ...base, id: 2, headerMessageId: "" },
    { ...base, id: 3, headerMessageId: "" },
  ];
  const [group] = groupDuplicates(headers, {});
  assert.equal(group.messages.length, 3);

  const contents = new Map([
    [1, { bodyText: "Rechnung über 100 €", attachments: [] }],
    [2, { bodyText: "Rechnung über 100 €", attachments: [] }],
    [3, { bodyText: "Rechnung über 999 €", attachments: [] }],
  ]);
  const verified = verifyGroup(group, contents);
  assert.equal(verified.length, 1, "die abweichende Mail bildet keine Gruppe mehr");
  assert.deepEqual(verified[0].messages.map((m) => m.id).sort(), [1, 2]);
  assert.ok(verified[0].verified);
});
