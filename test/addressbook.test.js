import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectAddressUsage,
  suggestPreferred,
  countDeviations,
  assessEntry,
  buildFolderBook,
  mergeIntoProfiles,
  summarizeBook,
  decodeExchangeAddress,
  describeRoles,
} from "../lib/addressbook.js";
import { collectCandidates, pickDefaults } from "../lib/candidates.js";
import { checkRecipient, applySuggestions } from "../lib/recipients.js";

/** Kopfdaten wie aus messages.list. */
const h = (author, to, cc) => ({
  author,
  recipients: to ? [to] : [],
  ccList: cc ? [cc] : [],
});

const HEADERS = [
  h("Bernd Muster <b.muster@example.org>", "Anna Beispiel <anna@example.de>"),
  h("b.muster@example.org", "anna@example.de"),
  h("Muster, Bernd <b.muster@example.org>", "Anna B. <anna@example.de>", "steuer@kanzlei.de"),
  h("Bernd Muster <b.muster@example.org>", "anna@example.de", "Kanzlei <steuer@kanzlei.de>"),
];

test("alle Adressen des Ordners werden mit ihren Schreibweisen gesammelt", () => {
  const usage = collectAddressUsage(HEADERS);
  const mails = usage.map((u) => u.email);
  assert.deepEqual(mails.sort(), ["anna@example.de", "b.muster@example.org", "steuer@kanzlei.de"]);

  const bernd = usage.find((u) => u.email === "b.muster@example.org");
  assert.equal(bernd.count, 4, "kommt in allen vier Mails vor");
  assert.deepEqual(bernd.roles, ["from"]);
  assert.deepEqual(
    bernd.names.map((n) => `${n.name}:${n.count}`),
    ["Bernd Muster:2", "Muster, Bernd:1"]
  );
  assert.equal(bernd.blank, 1, "einmal ganz ohne Namen");
});

test("Absender, Empfänger und Kopie zählen gleichermaßen", () => {
  const kanzlei = collectAddressUsage(HEADERS).find((u) => u.email === "steuer@kanzlei.de");
  assert.equal(kanzlei.count, 2);
  assert.deepEqual(kanzlei.roles, ["cc"]);
  assert.equal(kanzlei.blank, 1);
});

test("Vorschlag ist die häufigste echte Schreibweise", () => {
  const bernd = collectAddressUsage(HEADERS).find((u) => u.email === "b.muster@example.org");
  assert.equal(suggestPreferred(bernd), "Bernd Muster");
});

test("ein Name, der nur die Adresse wiederholt, taugt nicht als Vorschlag", () => {
  const usage = collectAddressUsage([
    h("max.mustermann <max.mustermann@example.de>", "a@b.de"),
    h("max.mustermann@example.de", "a@b.de"),
  ]);
  const max = usage.find((u) => u.email === "max.mustermann@example.de");
  assert.equal(suggestPreferred(max), "", "kein brauchbarer Name vorhanden");
  assert.ok(assessEntry(max).needsWork);
});

test("Abweichungen werden gezählt — das ist die Arbeitsmenge", () => {
  const bernd = collectAddressUsage(HEADERS).find((u) => u.email === "b.muster@example.org");
  // „Muster, Bernd" gilt als dieselbe Person (Wortdreher), bleibt also außen vor;
  // gezählt wird das eine Vorkommen ganz ohne Namen.
  assert.equal(countDeviations(bernd, "Bernd Muster"), 1);

  const anna = collectAddressUsage(HEADERS).find((u) => u.email === "anna@example.de");
  // „Anna B." ist ein anderer Name, dazu zwei Vorkommen ohne Namen
  assert.equal(countDeviations(anna, "Anna Beispiel"), 3);
});

test("Übersicht nennt Adressen und betroffene Vorkommen", () => {
  const book = buildFolderBook(HEADERS);
  const s = summarizeBook(book);
  assert.equal(s.total, 3);
  assert.ok(s.work >= 2);
  assert.match(s.text, /3 Adressen/);
});

test("Festlegungen werden zu Profilen — auch für fremde Personen", () => {
  const book = buildFolderBook(HEADERS);
  const decisions = book.map((e) => ({
    email: e.email,
    preferred: e.preferred || "Kanzlei Muster",
    names: e.names.map((n) => n.name),
  }));
  const { profiles, added } = mergeIntoProfiles(decisions, []);
  assert.equal(added, 3);

  const bernd = profiles.find((p) => p.emails.includes("b.muster@example.org"));
  assert.equal(bernd.preferredName, "Bernd Muster");
  // „Muster, Bernd" ist nur ein Wortdreher — sameName() erkennt das ohnehin,
  // also muss es nicht als eigene Variante mitgeschleppt werden.
  assert.deepEqual(bernd.names, []);

  // Ein echt anderer Name bleibt dagegen als Variante erhalten
  const anna = profiles.find((p) => p.emails.includes("anna@example.de"));
  assert.ok(anna.names.includes("Anna B."), `Varianten: ${anna.names.join(", ")}`);
});

test("bestehende Profile werden ergänzt, nicht verdoppelt", () => {
  const existing = [
    { id: "1", preferredName: "Alt", names: [], emails: ["b.muster@example.org"] },
  ];
  const { profiles, added, updated } = mergeIntoProfiles(
    [{ email: "B.Muster@example.org", preferred: "Bernd Muster", names: ["Muster, Bernd"] }],
    existing
  );
  assert.equal(added, 0);
  assert.equal(updated, 1);
  assert.equal(profiles.length, 1, "keine zweite Karteikarte für dieselbe Adresse");
  assert.equal(profiles[0].preferredName, "Bernd Muster");
});

// -------------------------------------------- Wirkung im Leuchttisch

test("nach dem Festlegen zeigt der Leuchttisch überall den richtigen Namen", () => {
  const { profiles } = mergeIntoProfiles(
    [
      { email: "anna@example.de", preferred: "Anna Beispiel", names: ["Anna B."] },
      { email: "b.muster@example.org", preferred: "Bernd Muster", names: [] },
    ],
    []
  );

  // Eine Kopie mit nackter Adresse und eine mit falschem Namen
  const copies = [
    {
      id: 1,
      subject: "Test",
      from: "b.muster@example.org",
      to: "anna@example.de",
      cc: "",
      date: "2024-04-03T10:00:00Z",
      bodyText: "Text",
      attachments: [],
    },
  ];
  const cands = collectCandidates(copies, { profiles });
  const sel = pickDefaults(cands, { profiles });

  assert.equal(sel.to, "Anna Beispiel <anna@example.de>", "Empfänger korrigiert");
  assert.equal(sel.from, "Bernd Muster <b.muster@example.org>", "Absender ebenso");

  // Und die Prüfung meldet die nackte Adresse als Befund mit Vorschlag
  const check = checkRecipient({ name: "", email: "anna@example.de" }, profiles);
  assert.equal(check.suggestion.name, "Anna Beispiel");
});

test("Adressen lassen sich auch aus einer geladenen Auswahl sammeln", () => {
  // So baut die Oberfläche die Kopfdaten, wenn kein Ordner geladen ist,
  // sondern nur markierte Nachrichten (msg.to/msg.cc sind Roh-Header).
  const msgs = [
    {
      header: { author: "Bernd Muster <b.muster@example.org>", recipients: [], ccList: [] },
      to: "anna@example.de",
      cc: "Kanzlei <steuer@kanzlei.de>",
    },
    {
      header: { author: "b.muster@example.org", recipients: [], ccList: [] },
      to: "Anna Beispiel <anna@example.de>",
      cc: "",
    },
  ];
  const headers = msgs.map((m) => ({
    author: m.header.author,
    recipients: m.to ? [m.to] : m.header.recipients || [],
    ccList: m.cc ? [m.cc] : m.header.ccList || [],
  }));

  const book = buildFolderBook(headers);
  const mails = book.map((e) => e.email).sort();
  assert.deepEqual(mails, ["anna@example.de", "b.muster@example.org", "steuer@kanzlei.de"]);

  const anna = book.find((e) => e.email === "anna@example.de");
  assert.equal(anna.count, 2);
  assert.equal(anna.blank, 1, "einmal nur die nackte Adresse");
  assert.equal(anna.preferred, "Anna Beispiel");
  assert.ok(anna.needsWork);
});

test("erkennt Exchange-Ersatzadressen und holt den Namen heraus", () => {
  const imcea =
    "imceaex-_o=exchangelabs_ou=exchange+20administrative+20group+20+28fydibohf23spdlt+29" +
    "_cn=recipients_cn=59cb036d3f09480ba685a75b0ed8a6c1-dirk+20trowe@eurprd06.prod.outlook.com";
  const info = decodeExchangeAddress(imcea);
  assert.ok(info.replacement);
  assert.equal(info.nameHint, "dirk trowe");

  // Normale Adressen bleiben unbehelligt
  assert.equal(decodeExchangeAddress("dirk.trowe@gmx.de").replacement, false);
});

test("schlägt für eine Ersatzadresse die echte Adresse aus dem Ordner vor", () => {
  const imcea =
    "imceaex-_o=exchangelabs_cn=recipients_cn=59cb036d3f09480ba685a75b0ed8a6c1-dirk+20trowe@eurprd06.prod.outlook.com";
  const book = buildFolderBook([
    { author: `Dirk Trowe <${imcea}>`, recipients: ["Karl-Peter Merz <kp@web.de>"] },
    { author: "Dirk Trowe <dirk.trowe@gmx.de>", recipients: ["Karl-Peter Merz <kp@web.de>"] },
  ]);
  const ersatz = book.find((e) => e.replacement);
  assert.ok(ersatz, "Ersatzadresse muss als solche erkannt werden");
  assert.equal(ersatz.emailSuggestion, "dirk.trowe@gmx.de");
  assert.ok(ersatz.needsWork, "auch bei einheitlichem Namen bleibt die Adresse zu klären");
});

test("die richtige Adresse landet als preferredEmail im Profil", () => {
  const { profiles } = mergeIntoProfiles(
    [{ email: "alt@firma-ex.prod.outlook.com", preferred: "Dirk Trowe", preferredEmail: "dirk.trowe@gmx.de", names: [] }],
    []
  );
  const p = profiles[0];
  assert.equal(p.preferredEmail, "dirk.trowe@gmx.de");
  assert.deepEqual(p.emails, ["dirk.trowe@gmx.de", "alt@firma-ex.prod.outlook.com"]);
});

test("Mails mit der alten Adresse werden auf die richtige umgeschrieben", () => {
  const profiles = [
    {
      id: "p1",
      preferredName: "Dirk Trowe",
      names: [],
      emails: ["dirk.trowe@gmx.de", "alt@firma-ex.prod.outlook.com"],
      preferredEmail: "dirk.trowe@gmx.de",
    },
  ];
  const res = checkRecipient({ name: "Dirk Trowe", email: "alt@firma-ex.prod.outlook.com" }, profiles);
  assert.ok(res.findings.some((f) => f.code === "old-address"));
  assert.deepEqual(res.suggestion, { name: "Dirk Trowe", email: "dirk.trowe@gmx.de" });
  assert.equal(
    applySuggestions("Dirk Trowe <alt@firma-ex.prod.outlook.com>", profiles),
    "Dirk Trowe <dirk.trowe@gmx.de>"
  );
});

test("Rollen werden ausgeschrieben", () => {
  assert.equal(describeRoles(["from", "to"]), "als Absender und als Empfänger");
  assert.equal(describeRoles(["cc"]), "in Kopie");
});
