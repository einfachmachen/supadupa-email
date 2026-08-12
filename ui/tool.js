// tool.js — Oberfläche: Nachrichten laden, prüfen, Empfänger reparieren.

import {
  parseAddressList,
  formatAddressList,
  formatAddress,
  decodeHeaderValue,
} from "../lib/mime.js";
import {
  checkRecipientList,
  deriveProfiles,
  profileNames,
  applySuggestions,
  sameName,
} from "../lib/recipients.js";
import {
  groupDuplicates,
  summarize,
  removableIds,
  MODES,
  MODE_LABELS,
  looserMode,
} from "../lib/dedupe.js";
import { openLightTable } from "./lighttable.js";
import {
  createReview,
  setMark,
  markOf,
  overview,
  groupByMark,
  markCounts,
  pendingGroups,
  describePlan,
  MARKS,
  MARK_LABELS,
} from "../lib/review.js";
import { buildRebuild } from "../lib/rebuild.js";
import {
  buildFolderBook,
  mergeIntoProfiles,
  summarizeBook,
  describeRoles,
} from "../lib/addressbook.js";
import { checkAttachments, suggestName } from "../lib/attachments.js";
import { compareTexts, classify, compareFacts, htmlToText } from "../lib/similarity.js";
import {
  loadMessage,
  rewriteHeaders,
  rawHeader,
  listFolders,
  listAllMessages,
  deleteMessages,
  loadForLightTable,
  inlineImageList,
  importAssembled,
  folderOf,
  contactPairs,
  messengerApi as api,
} from "../lib/messageStore.js";

const $ = (sel) => document.querySelector(sel);
const state = {
  msgs: [], // geladene Einzelnachrichten (mit Body/Anhängen)
  profiles: [],
  busy: false,
  folder: null, // aktuell geladener Ordner
  headers: [], // Kopfdaten des Ordners (ohne Body)
  groups: [], // Duplikat-Gruppen
  // Immer beim sichersten Schärfegrad anfangen: „streng“ findet nur
  // zweifelsfreie Kopien. Erst wenn dort nichts (mehr) zu holen ist, wird
  // gelockert — Schritt für Schritt und sichtbar.
  mode: MODES.strict,
  autoStepped: [], // Schärfegrade, die automatisch übersprungen wurden
  review: null, // laufender Durchgang: nur Vormerkungen, keine Änderungen
  table: null, // offener Leuchttisch
  book: [], // Adressen des Ordners (Namen-Varianten je Adresse)
  bookFix: new Map(), // Adresse → festgelegter Name
  bookFixEmail: new Map(), // Adresse → richtige Adresse (bei Ersatzadressen)
  bookOnlyWork: true, // nur Adressen mit uneinheitlicher Schreibweise zeigen
};

// ---------------------------------------------------------------- Hilfsmittel

function toast(text, isError = false) {
  const el = $("#toast");
  el.textContent = text;
  el.className = `toast${isError ? " error" : ""}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 5000);
}

function setStatus(text) {
  $("#status").textContent = text;
}

function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function findingRow(f) {
  const row = el("div", `finding ${f.level}`);
  row.append(el("span", "dot"), el("span", null, f.text));
  return row;
}

function bodyText(msg) {
  return msg.body.plain?.trim() ? msg.body.plain : htmlToText(msg.body.html);
}

// ------------------------------------------------------------------- Profile

async function loadProfiles() {
  const { profiles } = await api.storage.local.get("profiles");
  state.profiles = Array.isArray(profiles) ? profiles : [];
  renderProfiles();
}

async function saveProfiles() {
  readProfileInputs();
  await api.storage.local.set({ profiles: state.profiles });
  // Schritt 2 ist erledigt — zuklappen, damit die Übersicht den Platz bekommt.
  $("#profileBox").open = false;
  toast("Profile gespeichert.");
  analyzeAll();
}

function readProfileInputs() {
  const rows = [...document.querySelectorAll("#profiles .profile")];
  state.profiles = rows
    .map((row) => ({
      id: row.dataset.id,
      preferredName: row.querySelector('[data-k="preferredName"]').value.trim(),
      names: row
        .querySelector('[data-k="names"]')
        .value.split(/\s*[;,]\s*/)
        .map((s) => s.trim())
        .filter(Boolean),
      emails: row
        .querySelector('[data-k="emails"]')
        .value.split(/\s*[;,]\s*/)
        .map((s) => s.trim())
        .filter(Boolean),
      // Leer lassen heißt: alle Adressen des Profils gelten gleichermaßen.
      preferredEmail: row.querySelector('[data-k="preferredEmail"]').value.trim(),
    }))
    .filter((p) => p.preferredName || p.emails.length);
}

function renderProfiles() {
  const box = $("#profiles");
  box.textContent = "";
  if (!state.profiles.length) {
    box.append(el("div", "muted", "Noch kein Profil — leg eines an, damit die Namensprüfung greift."));
  }
  for (const p of state.profiles) {
    const row = el("div", "profile");
    row.dataset.id = p.id || String(Math.random()).slice(2);
    const field = (key, label, value) => {
      const l = el("label", null, label);
      const i = document.createElement("input");
      i.dataset.k = key;
      i.value = value || "";
      l.append(i);
      return l;
    };
    row.append(
      field("preferredName", "Bevorzugter Name", p.preferredName),
      field("names", "Weitere Schreibweisen (Komma)", (p.names || []).join(", ")),
      field("emails", "Adressen (Komma)", (p.emails || []).join(", ")),
      field("preferredEmail", "Richtige Adresse (optional)", p.preferredEmail)
    );
    const del = el("button", "ghost", "×");
    del.title = "Profil entfernen";
    del.onclick = () => {
      readProfileInputs();
      state.profiles = state.profiles.filter((x) => x.id !== row.dataset.id);
      renderProfiles();
    };
    row.append(del);
    box.append(row);
  }
}

async function profilesFromAddressBook() {
  readProfileInputs();
  const derived = deriveProfiles(await contactPairs());
  const known = new Set(
    state.profiles.flatMap((p) => (p.emails || []).map((e) => e.toLowerCase()))
  );
  const added = derived.filter((p) => !known.has(p.emails[0].toLowerCase()));
  state.profiles = [...state.profiles, ...added];
  renderProfiles();
  toast(`${added.length} Adresse(n) aus dem Adressbuch übernommen — bitte prüfen und speichern.`);
}

// ------------------------------------------------------------------- Laden

async function loadIds(ids) {
  if (!ids.length) {
    state.msgs = [];
    render();
    setStatus("Keine Nachricht ausgewählt. Wähle Mails im Hauptfenster und klicke „Auswahl laden“.");
    return;
  }
  setStatus(`${ids.length} Nachricht(en) werden gelesen …`);
  const out = [];
  for (const id of ids) {
    try {
      if (ids.length > 5) setStatus(`Lese … ${out.length + 1}/${ids.length}`);
      const msg = await loadMessage(id);
      msg.to = await rawHeader(id, "To").catch(() => "");
      if (!msg.to) msg.to = formatAddressList(msg.header.recipients?.map(parseOne) || []);
      msg.cc = await rawHeader(id, "Cc").catch(() => "");
      out.push(msg);
    } catch (e) {
      console.error(e);
      toast(`Nachricht ${id} konnte nicht gelesen werden: ${e.message}`, true);
    }
  }
  state.msgs = out;
  analyzeAll();
}

function parseOne(s) {
  return parseAddressList(s)[0] || { name: "", email: "" };
}

async function loadSelection() {
  const res = await api.runtime.sendMessage({ type: "getSelection" }).catch(() => null);
  let ids = res?.ids || [];
  let folder = res?.folder || null;
  if (!ids.length) {
    const pending = await api.runtime.sendMessage({ type: "getPending" }).catch(() => null);
    ids = pending?.ids || [];
    folder = folder || pending?.folder || null;
  }
  // Der Ordner zuerst: Er füllt Übersicht und Adressliste, die Auswahl
  // danach die Einzelansicht.
  if (folder && (!state.folder || state.folder.path !== folder.path)) {
    await adoptFolderFromMailTab(folder);
  }
  await loadIds(ids);
}

async function fillFolders() {
  try {
    const folders = await listFolders();
    const sel = $("#folderSel");
    for (const f of folders) {
      const o = document.createElement("option");
      o.value = f.id || f.path;
      o.textContent = f.path;
      o._folder = f.folder;
      sel.append(o);
    }
  } catch (e) {
    console.warn("Ordnerliste nicht verfügbar", e);
  }
}

// ------------------------------------------------------------------ Analyse

function analyzeAll() {
  for (const msg of state.msgs) {
    const text = bodyText(msg);
    msg.recipients = checkRecipientList(msg.to, state.profiles);
    msg.atts = checkAttachments(msg.attachments, {
      subject: msg.header.subject,
      body: text,
      date: msg.header.date,
    });
    msg.text = text;
  }
  if (!state.headers.length && state.msgs.length) buildBook();
  render();
  const bad = state.msgs.filter((m) => !m.recipients.ok || m.recipients.empty).length;
  setStatus(
    `${state.msgs.length} Nachricht(en) geprüft · ` +
      (bad ? `${bad} mit Empfänger-Problem` : "Empfänger überall stimmig") +
      (state.headers.length ? ` · Ordner: ${state.headers.length} Nachrichten` : "")
  );
}

// --------------------------------------------------------------- Duplikate

async function loadFolder(folder) {
  if (state.busy) return;
  state.busy = true;
  state.folder = folder;
  state.msgs = [];
  render();
  try {
    setStatus("Ordner wird gelesen …");
    state.headers = await listAllMessages(folder, {
      onProgress: (n) => setStatus(`Ordner wird gelesen … ${n} Nachrichten`),
    });
    buildBook();
    // Jeder Ordner beginnt beim sichersten Schärfegrad.
    state.mode = MODES.strict;
    state.autoStepped = [];
    regroup();
  } catch (e) {
    console.error(e);
    toast(`Ordner konnte nicht gelesen werden: ${e.message}`, true);
    setStatus("Fehler beim Lesen des Ordners.");
  } finally {
    state.busy = false;
  }
}

function regroup({ auto = true } = {}) {
  state.groups = groupDuplicates(state.headers, {
    mode: state.mode,
    profiles: state.profiles,
  });
  // Findet der sichere Schärfegrad gar nichts, hat es keinen Sinn, den
  // Benutzer davorstehen zu lassen — dann eine Stufe lockerer, aber sichtbar
  // protokolliert. Nur solange noch nichts vorgemerkt ist.
  const nothingMarked = !state.review || markCounts(state.review).decided === 0;
  if (auto && nothingMarked && !state.groups.length && looserMode(state.mode)) {
    state.autoStepped = [...state.autoStepped, state.mode];
    state.mode = looserMode(state.mode);
    return regroup({ auto: true });
  }
  const s = summarize(state.groups);
  setStatus(
    `${state.headers.length} Nachrichten · ${s.groups} Duplikat-Gruppen · ` +
      `${s.removable} entfernbare Kopien`
  );
  if (state.review) state.review = createReview(state.groups, { marks: state.review.marks });
  renderGroups();
  render();
}

// --------------------------------------------------- Adressen des Ordners

/**
 * Sammelt alle Namen/Adressen des geladenen Ordners. Einmal festlegen, wie
 * eine Adresse richtig heißt — danach greift es überall.
 */
function buildBook() {
  // Quelle: die Kopfdaten des Ordners — und wenn keiner geladen ist, die
  // gerade geladene Auswahl. Sonst stünde die Klappe leer da, obwohl
  // Nachrichten sichtbar sind.
  const headers = state.headers.length
    ? state.headers
    : state.msgs.map((m) => ({
        author: m.header.author,
        recipients: m.to ? [m.to] : m.header.recipients || [],
        ccList: m.cc ? [m.cc] : m.header.ccList || [],
      }));
  state.book = buildFolderBook(headers);
  state.bookFix = new Map();
  state.bookFixEmail = new Map();
  for (const e of state.book) {
    // Bereits als Profil festgelegt? Dann gilt das, sonst der Vorschlag.
    const known = state.profiles.find((p) =>
      (p.emails || []).some((x) => String(x).toLowerCase() === e.email)
    );
    state.bookFix.set(e.email, known?.preferredName || e.preferred || "");
    state.bookFixEmail.set(e.email, known?.preferredEmail || e.emailSuggestion || "");
  }
  // Schritt 1 steht am Anfang: aufgeklappt, solange es dort etwas zu tun gibt.
  $("#bookBox").open = state.book.some((e) => e.needsWork);
  renderBook();
}

/** Woher stammen die Adressen gerade? Das gehört in die Kopfzeile. */
function bookSource() {
  if (state.headers.length) return `Ordner (${state.headers.length} Nachrichten)`;
  if (state.msgs.length) return `geladene Auswahl (${state.msgs.length} Nachrichten)`;
  return "";
}

function renderBook() {
  const box = $("#bookList");
  box.textContent = "";
  const sum = summarizeBook(state.book);
  const src = bookSource();
  $("#bookSummary").textContent = src ? `${sum.text} · aus ${src}` : sum.text;
  $("#btnBookOnlyWork").textContent = state.bookOnlyWork
    ? `alle ${sum.total} zeigen`
    : "nur uneinheitliche zeigen";

  const shown = state.bookOnlyWork ? state.book.filter((e) => e.needsWork) : state.book;
  if (!shown.length) {
    box.append(
      el(
        "div",
        "muted",
        state.book.length
          ? "Alle Adressen sind einheitlich."
          : "Noch nichts geladen — wähle einen Ordner oder lade eine Auswahl."
      )
    );
    return;
  }

  // Spaltenüberschrift — sonst ist nicht zu erraten, wozu das Feld rechts da ist.
  const head = el("div", "book-row head");
  head.append(el("div", "addr", "So steht es in den Mails"));
  head.append(el("div", "fix", "So soll es künftig heißen"));
  box.append(head);

  for (const e of shown.slice(0, 300)) {
    const row = el("div", `book-row${e.needsWork ? "" : " ok"}`);

    const addr = el("div", "addr");
    addr.append(el("div", "mail", e.email));
    const rollen = describeRoles(e.roles);
    addr.append(
      el(
        "div",
        "meta",
        `${e.count}× im Ordner` +
          (rollen ? ` · ${rollen}` : "") +
          (e.deviations ? ` · ${e.deviations}× mit abweichendem Namen` : " · Name einheitlich")
      )
    );
    if (e.replacement) {
      addr.append(
        el(
          "div",
          "warnline",
          `Keine echte Adresse, sondern eine ${e.replacementWhy}. ` +
            (e.emailSuggestion
              ? `Im Ordner gibt es dazu ${e.emailSuggestion} — rechts als Adresse eingetragen.`
              : "Trage rechts die richtige Adresse ein.")
        )
      );
    }
    const chips = el("div", "chips");
    for (const n of e.names.slice(0, 6)) {
      const c = el("button", "chip zaehler", `${n.name} (${n.count})`);
      c.title = "Diese Schreibweise als die richtige übernehmen";
      c.onclick = () => {
        state.bookFix.set(e.email, n.name);
        nameInput.value = n.name;
        markChips();
      };
      c.dataset.name = n.name;
      chips.append(c);
    }
    if (e.blank) chips.append(el("span", "chip leer", `${e.blank}× ganz ohne Namen`));
    addr.append(chips);

    const fix = el("div", "fix");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = state.bookFix.get(e.email) || "";
    nameInput.placeholder = "richtiger Name";
    nameInput.setAttribute("aria-label", `Richtiger Name für ${e.email}`);
    const mailInput = document.createElement("input");
    mailInput.type = "text";
    mailInput.value = state.bookFixEmail.get(e.email) || "";
    mailInput.placeholder = "richtige Adresse (nur wenn abweichend)";
    mailInput.setAttribute("aria-label", `Richtige Adresse statt ${e.email}`);

    const markChips = () => {
      const cur = state.bookFix.get(e.email) || "";
      for (const c of chips.querySelectorAll(".chip.zaehler")) {
        c.classList.toggle("aktiv", !!cur && sameName(c.dataset.name, cur));
      }
    };
    nameInput.addEventListener("input", () => {
      state.bookFix.set(e.email, nameInput.value.trim());
      markChips();
    });
    mailInput.addEventListener("input", () =>
      state.bookFixEmail.set(e.email, mailInput.value.trim())
    );
    markChips();

    fix.append(nameInput, mailInput);
    row.append(addr, fix);
    box.append(row);
  }
  if (shown.length > 300) {
    box.append(el("div", "muted", `… ${shown.length - 300} weitere Adressen (erst die häufigsten).`));
  }
}

/** Festlegungen in Profile überführen — ab dann greifen sie überall. */
async function saveBook() {
  const decisions = state.book
    .map((e) => ({
      email: e.email,
      preferred: (state.bookFix.get(e.email) || "").trim(),
      preferredEmail: (state.bookFixEmail.get(e.email) || "").trim(),
      names: e.names.map((n) => n.name),
    }))
    .filter((d) => d.preferred || d.preferredEmail);

  if (!decisions.length) {
    toast("Weder Name noch Adresse festgelegt.", true);
    return;
  }
  const { profiles, added, updated } = mergeIntoProfiles(decisions, state.profiles);
  state.profiles = profiles;
  await api.storage.local.set({ profiles });
  renderProfiles();
  renderBook();
  // Schritt 1 ist erledigt: zuklappen und Schritt 2 aufklappen, damit man
  // sieht, was daraus geworden ist.
  $("#bookBox").open = false;
  $("#profileBox").open = true;
  if (state.headers.length) regroup();
  analyzeAll();
  toast(`${added} Profil(e) neu, ${updated} aktualisiert — jetzt Schritt 2 prüfen.`);
}

/**
 * Übersicht nach dem Einlesen: Wie viele Nachrichten, wie viele davon
 * eindeutig — und ein einziger Knopf, der den Durchgang startet.
 */
function renderGroups() {
  const box = $("#dupes");
  const body = $("#dupesBody");
  body.textContent = "";
  if (!state.headers.length) {
    box.classList.add("hidden");
    renderMarksBox();
    updateStart();
    return;
  }
  box.classList.remove("hidden");

  const ov = overview(state.groups, state.headers.length);
  $("#dupeSummary").textContent =
    `${ov.total} Nachrichten · ${ov.unique} eindeutige · ` +
    `${ov.groups} Gruppen mit Dubletten (${ov.inGroups} Kopien, ${ov.removable} entfernbar)` +
    (ov.singles ? ` · ${ov.singles} Einzelstücke ohne Dublette` : "");

  renderMode();

  if (!state.groups.length) {
    body.append(
      el(
        "div",
        "muted",
        "Keine Dubletten — auch beim großzügigsten Schärfegrad nicht. In diesem " +
          "Ordner ist nichts doppelt."
      )
    );
    renderMarksBox();
    updateStart();
    return;
  }

  // In der Übersicht steht nur, was noch zu tun ist: unentschiedene Gruppen und
  // die, die du auf „später“ gelegt hast. Zusammenfassen/Löschen wandert nach
  // unten in die Vormerkungen.
  const open = openGroups();
  if (!open.length) {
    body.append(el("div", "muted", "Alle Gruppen sind vorgemerkt — weiter bei den Vormerkungen."));
  } else {
    const laterCount = open.filter(
      (g) => state.review && markOf(state.review, g.key) === MARKS.later
    ).length;
    body.append(
      el(
        "div",
        "muted",
        `${open.length} Gruppe(n) offen` +
          (laterCount ? ` (davon ${laterCount} auf „später nochmal prüfen“)` : "") +
          " — der Leuchttisch führt dich hindurch. Dort wird nur vorgemerkt."
      )
    );
    body.append(renderGroupList(open.slice(0, 30), open.length));
  }
  renderMarksBox();
  updateStart();
}

/**
 * Der Schärfegrad: welcher gilt, was das heißt, und was automatisch
 * übersprungen wurde. Ohne diese Zeile weiß man nicht, wie sicher ein Fund ist.
 */
function renderMode() {
  $("#modeHint").textContent = `Schärfegrad: ${MODE_LABELS[state.mode]}`;
  const erklaerung = {
    [MODES.strict]: "nur zweifelsfreie Kopien (gleiche Message-ID)",
    [MODES.normal]: "Message-ID, sonst Absender + Betreff + dieselbe Minute",
    [MODES.lose]: "Absender + Betreff + derselbe Tag — bitte jede Gruppe ansehen",
  }[state.mode];
  const ladder = $("#modeLadder");
  ladder.textContent = "";
  ladder.append(el("span", null, `${erklaerung}. `));
  if (state.autoStepped.length) {
    ladder.append(
      el(
        "span",
        null,
        `Übersprungen, weil dort nichts gefunden wurde: ` +
          `${state.autoStepped.map((m) => MODE_LABELS[m]).join(", ")}. `
      )
    );
  }
  const next = looserMode(state.mode);
  if (next && state.groups.length && !openGroups().length) {
    const b = el("button", "chip", `alles abgearbeitet — weiter mit „${MODE_LABELS[next]}“`);
    b.onclick = () => switchMode(next);
    ladder.append(b);
  }
}

/** Schärfegrad von Hand wechseln — die Gruppen bilden sich dabei neu. */
function switchMode(mode) {
  if (!mode || mode === state.mode) return;
  if (
    state.review &&
    markCounts(state.review).decided &&
    !window.confirm(
      "Ein anderer Schärfegrad bildet die Gruppen neu — die bisherigen " +
        "Vormerkungen gehen dabei verloren. Fortfahren?"
    )
  ) {
    return;
  }
  state.mode = mode;
  state.autoStepped = [];
  state.review = null;
  // Von Hand gewählt heißt: genau dieser Grad, keine automatische Stufe weiter.
  if (state.headers.length) regroup({ auto: false });
  else renderGroups();
}

/** Gruppen, die noch in die Übersicht gehören: offen oder „später“. */
function openGroups() {
  return state.review ? pendingGroups(state.review) : state.groups;
}

/** Der Startknopf ganz oben — ein Weg hinein, mit klarer Beschriftung. */
function updateStart() {
  const btn = $("#btnStart");
  const hint = $("#startHint");
  const open = state.groups.length ? openGroups() : [];
  btn.disabled = !open.length;
  if (!state.headers.length) {
    btn.textContent = "Leuchttisch starten";
    hint.textContent = "Erst einen Ordner laden.";
    return;
  }
  if (!state.groups.length) {
    btn.textContent = "Leuchttisch starten";
    hint.textContent = "Keine Dubletten nach diesem Maßstab.";
    return;
  }
  if (!open.length) {
    btn.textContent = "Leuchttisch starten";
    hint.textContent = "Alle Gruppen sind vorgemerkt — weiter bei Schritt 4.";
    return;
  }
  const started = state.review && markCounts(state.review).decided > 0;
  btn.textContent = started
    ? `Weiter im Leuchttisch (${open.length} offen)`
    : `Leuchttisch starten (${open.length} Gruppen)`;
  hint.textContent = "Öffnet die erste offene Dublette.";
}

/** Knappe Liste der Gruppen (Betreff, Datum, Anzahl Kopien). */
function renderGroupList(groups, total) {
  const wrap = el("div");
  for (const g of groups) {
    const first = g.messages[0];
    const row = el("div", "att");
    const info = el("div", "name");
    info.append(el("div", null, decodeHeaderValue(first.subject) || "(kein Betreff)"));
    info.append(
      el(
        "div",
        "meta",
        `${new Date(first.date).toLocaleDateString("de-DE")} · ${g.messages.length} Kopien · ` +
          decodeHeaderValue(first.author || "")
      )
    );
    if (g.match) {
      const badge = el("span", `matchbadge ${g.match.level}`, MODE_LABELS[g.match.level]);
      badge.title = g.match.text;
      info.append(el("div", "meta", `erkannt: ${g.match.text}`));
      info.prepend(badge);
    }
    const open = el("button", "chip", "ansehen");
    open.onclick = () => startReview(state.groups.indexOf(g));
    row.append(info, open);
    wrap.append(row);
  }
  if (total > groups.length) {
    wrap.append(el("div", "muted", `… und ${total - groups.length} weitere Gruppen.`));
  }
  return wrap;
}

/**
 * Schritt 4: die Vormerkungen, getrennt nach zusammenfassen und löschen —
 * mit den Knöpfen, die als Einzige wirklich etwas verändern.
 */
function renderMarksBox() {
  const box = $("#marksBox");
  const body = $("#marksBody");
  body.textContent = "";
  const by = state.review ? groupByMark(state.review) : null;
  if (!by || (!by.merge.length && !by.delete.length)) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  const counts = markCounts(state.review);
  $("#marksSummary").textContent =
    `${counts.merge} zum Zusammenfassen · ${counts.delete} zum Löschen · ` +
    `${counts.later} auf später · ${counts.none} noch offen. Nichts davon ist bisher ausgeführt.`;

  const section = (kind, list, extra) => {
    if (!list.length) return;
    const fold = document.createElement("details");
    fold.className = `lt-fold${kind === MARKS.delete ? " warn" : ""}`;
    fold.open = true;
    const sum = document.createElement("summary");
    sum.append(el("span", "t", `${MARK_LABELS[kind]} (${list.length})`));
    const copies = list.reduce((n, g) => n + g.messages.length, 0);
    sum.append(el("span", "s", `${copies} Kopien betroffen`));
    fold.append(sum);
    if (extra) fold.append(extra);
    fold.append(renderGroupList(list, list.length));
    body.append(fold);
  };

  const mergeBar = el("div", "bar");
  const bMerge = el("button", "primary", `${by.merge.length} Gruppe(n) jetzt zusammenfassen`);
  bMerge.onclick = () => executeMarks(MARKS.merge);
  mergeBar.append(bMerge);

  const delBar = el("div", "bar");
  const bDel = el("button", "danger", `${by.delete.length} Gruppe(n) jetzt bereinigen`);
  bDel.onclick = () => executeMarks(MARKS.delete);
  delBar.append(bDel);

  section(MARKS.merge, by.merge, by.merge.length ? mergeBar : null);
  section(MARKS.delete, by.delete, by.delete.length ? delBar : null);

  const bar = el("div", "bar");
  const reset = el("button", "ghost", "Vormerkungen verwerfen");
  reset.onclick = () => {
    if (!window.confirm("Alle Vormerkungen verwerfen?")) return;
    state.review = null;
    renderGroups();
  };
  bar.append(reset);
  body.append(bar);
}

/** Nächste Gruppe, die noch Arbeit macht — „später“ zählt dazu. */
function nextUndecided() {
  const first = openGroups()[0];
  const i = first ? state.groups.indexOf(first) : -1;
  return i < 0 ? 0 : i;
}


// ------------------------------------------------------------- Durchgang
//
// Einmal durch alle Gruppen: ansehen, vormerken, weiter. Ausgeführt wird
// nichts — die Vormerkungen sammeln sich, bis du sie in der Übersicht
// bestätigst.

/** Startet (oder setzt fort) den Durchgang. */
async function startReview(index = 0) {
  if (!state.groups.length) return;
  if (!state.review || state.review.groups !== state.groups) {
    state.review = createReview(state.groups, { marks: state.review?.marks });
  }
  await openReviewAt(Math.max(0, Math.min(index, state.groups.length - 1)));
}

async function openReviewAt(index) {
  const group = state.groups[index];
  if (!group) return finishReview(true);
  state.table?.close?.();
  state.table = null;
  state.review.index = index;

  const ids = group.messages.map((m) => m.id);
  try {
    state.table = await openLightTable(ids, {
      profiles: state.profiles,
      onStatus: setStatus,
      onToast: toast,
      review: {
        index,
        total: state.groups.length,
        match: group.match,
        currentMark: markOf(state.review, group.key),
        onDecide: async (kind) => {
          if (kind) state.review = { ...setMark(state.review, group.key, kind), index };
          await saveReview();
          const next = index + 1;
          if (next < state.groups.length) await openReviewAt(next);
          else finishReview(true);
        },
        onFinish: () => finishReview(),
      },
    });
  } catch (e) {
    console.error(e);
    toast(`Gruppe ${index + 1} konnte nicht geöffnet werden: ${e.message}`, true);
    finishReview();
  }
}

function finishReview(complete = false) {
  state.table?.close?.();
  state.table = null;
  renderGroups();
  if (state.review) {
    const c = markCounts(state.review);
    setStatus(
      `Durchgang ${complete ? "abgeschlossen" : "unterbrochen"} · ` +
        `${c.merge} zusammenfassen · ${c.delete} löschen · ${c.later} später · ${c.none} offen`
    );
  }
}

async function saveReview() {
  try {
    await api.storage.local.set({
      [`review:${state.folder?.path || "unbekannt"}`]: { marks: state.review.marks },
    });
  } catch (e) {
    console.warn("Vormerkungen nicht gespeichert", e);
  }
}

/** Führt die Vormerkungen einer Art aus — mit Rückfrage im Klartext. */
async function executeMarks(kind) {
  if (state.busy || !state.review) return;
  const list = groupByMark(state.review)[kind];
  if (!list.length) return;

  const permanent = $("#permDelete").checked;
  const what =
    kind === MARKS.merge
      ? `${list.length} Gruppe(n) werden zu je EINER neuen Nachricht zusammengefasst.`
      : `${list.length} Gruppe(n) werden bereinigt — überzählige Kopien ` +
        (permanent ? "ENDGÜLTIG gelöscht." : "in den Papierkorb.");
  const lines = describePlan(state.review).join("\n");
  if (!window.confirm(`${what}\n\n${lines}\n\nAusführen?`)) return;

  state.busy = true;
  const done = [];
  const failed = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      setStatus(
        `${kind === MARKS.merge ? "Fasse zusammen" : "Bereinige"} … ${i + 1}/${list.length}`
      );
      try {
        if (kind === MARKS.merge) await mergeOneMarkedGroup(g, permanent);
        else {
          const ids = removableIds(g);
          if (ids.length) await deleteMessages(ids, { permanent });
        }
        done.push(g);
      } catch (e) {
        console.error(e);
        failed.push(`${decodeHeaderValue(g.messages[0].subject)}: ${e.message}`);
      }
    }
  } finally {
    state.busy = false;
  }

  // Erledigte Gruppen aus Liste und Vormerkungen nehmen
  const gone = new Set(done.map((g) => g.key));
  state.groups = state.groups.filter((g) => !gone.has(g.key));
  const marks = { ...state.review.marks };
  for (const k of gone) delete marks[k];
  const touched = new Set(done.flatMap((g) => g.messages.map((m) => m.id)));
  state.headers = state.headers.filter((h) => !touched.has(h.id));
  state.review = { ...state.review, marks, groups: state.groups };
  await saveReview();
  renderGroups();

  toast(
    failed.length
      ? `${done.length} erledigt, ${failed.length} fehlgeschlagen (Details in der Konsole).`
      : `${done.length} Gruppe(n) erledigt.`,
    failed.length > 0
  );
  if (failed.length) console.error("Fehlgeschlagen:", failed);
}

/** Eine vorgemerkte Gruppe zusammenfassen — derselbe Weg wie im Leuchttisch. */
async function mergeOneMarkedGroup(g, permanent = false) {
  const ids = g.messages.map((m) => m.id);
  const copies = [];
  for (const id of ids) {
    const loaded = await loadForLightTable(id);
    loaded.inline = inlineImageList(loaded);
    copies.push(loaded);
  }
  const { bytes } = buildRebuild(copies, { profiles: state.profiles, keepHtml: true });
  const folder = await folderOf(copies[0].header);
  const imported = await importAssembled(bytes, folder);
  await deleteMessages(
    ids.filter((id) => id !== imported.id),
    { permanent }
  );
  return imported;
}


/** Öffnet den Leuchttisch für beliebige Nachrichten-IDs. */
async function openTableFor(ids) {
  if (state.busy || !ids.length) return;
  state.busy = true;
  try {
    await openLightTable(ids, {
      profiles: state.profiles,
      onStatus: setStatus,
      onToast: toast,
      onDone: async ({ newId, removed }) => {
        if (removed?.length) {
          const gone = new Set(removed);
          state.headers = state.headers.filter((h) => !gone.has(h.id));
          state.groups = state.groups
            .map((g) => ({ ...g, messages: g.messages.filter((m) => !gone.has(m.id)) }))
            .filter((g) => g.messages.length > 1);
          renderGroups();
        }
        await loadIds([newId]);
      },
    });
  } catch (e) {
    console.error(e);
    toast(`Leuchttisch konnte nicht geöffnet werden: ${e.message}`, true);
  } finally {
    state.busy = false;
  }
}

/** Baut aus einer Gruppe eine vollständige Nachricht und ersetzt die Kopien. */
// ------------------------------------------------------------------ Rendern

function render() {
  const list = $("#list");
  list.textContent = "";
  for (const msg of state.msgs) list.append(renderCard(msg));
  renderCompare();
}

function renderCard(msg) {
  const card = el("div", "card");
  const row = el("div", "row1");
  const main = el("div", "subject");
  main.append(el("div", null, decodeHeaderValue(msg.header.subject) || "(kein Betreff)"));
  const from = msg.header.author ? decodeHeaderValue(msg.header.author) : "";
  main.append(
    el(
      "div",
      "meta",
      `${new Date(msg.header.date).toLocaleString("de-DE")} · von ${from} · an ${
        decodeHeaderValue(msg.to) || "—"
      }`
    )
  );
  row.append(main);
  card.append(row);

  const badges = el("div", "badges");
  const recLevel = msg.recipients.empty
    ? "error"
    : msg.recipients.ok
    ? "ok"
    : msg.recipients.results.some((r) => r.findings.some((f) => f.level === "error"))
    ? "error"
    : "warn";
  badges.append(
    el(
      "span",
      `badge ${recLevel}`,
      recLevel === "ok" ? "Empfänger ok" : "Empfänger prüfen"
    )
  );
  const attErr = [...msg.atts.findings, ...msg.atts.items.flatMap((i) => i.findings)];
  const attLevel = attErr.some((f) => f.level === "error")
    ? "error"
    : attErr.some((f) => f.level === "warn")
    ? "warn"
    : "ok";
  badges.append(
    el("span", `badge ${attLevel}`, `${msg.attachments.length} Anhang/Anhänge`)
  );
  badges.append(el("span", "badge", `${msg.text.trim().split(/\s+/).filter(Boolean).length} Wörter`));
  card.append(badges);

  card.append(renderRecipients(msg));
  card.append(renderAttachments(msg));
  return card;
}

// --- Empfänger-Editor -------------------------------------------------------

function renderRecipients(msg) {
  const sec = el("section", "block");
  sec.append(el("h3", null, "Empfänger (To)"));

  const rows = [];
  const entries = msg.recipients.empty ? [{ name: "", email: "" }] : msg.recipients.list;

  entries.forEach((rec, idx) => {
    const res = msg.recipients.results[idx] || { findings: [], suggestion: null };
    const box = el("div", "rec");
    const fields = el("div", "fields");

    const mk = (key, label, value) => {
      const l = el("label", null, label);
      const i = document.createElement("input");
      i.value = value || "";
      i.dataset.k = key;
      i.placeholder = key === "name" ? "Vor- und Nachname" : "adresse@beispiel.de";
      i.addEventListener("input", () => updatePreview());
      l.append(i);
      return { label: l, input: i };
    };
    const nameF = mk("name", "Name", rec.name);
    const mailF = mk("email", "E-Mail-Adresse", rec.email);
    fields.append(nameF.label, mailF.label);
    box.append(fields);
    rows.push({ name: nameF.input, email: mailF.input });

    for (const f of res.findings) box.append(findingRow(f));

    const chips = el("div", "chips");
    if (res.suggestion) {
      const c = el(
        "button",
        "chip suggest",
        `Vorschlag: ${formatAddress(res.suggestion)}`
      );
      c.onclick = () => {
        nameF.input.value = res.suggestion.name || "";
        mailF.input.value = res.suggestion.email || "";
        updatePreview();
      };
      chips.append(c);
    }
    for (const p of state.profiles) {
      for (const n of profileNames(p).slice(0, 2)) {
        for (const mail of p.emails || []) {
          const c = el("button", "chip", `${n} <${mail}>`);
          c.onclick = () => {
            nameF.input.value = n;
            mailF.input.value = mail;
            updatePreview();
          };
          chips.append(c);
        }
      }
    }
    if (chips.children.length) box.append(chips);
    sec.append(box);
  });

  const preview = el("div", "muted");
  const actions = el("div", "bar");
  const addBtn = el("button", "ghost", "+ Empfänger");
  const saveBtn = el("button", "primary", "Empfänger speichern");
  const permBox = document.createElement("label");
  permBox.className = "muted";
  const perm = document.createElement("input");
  perm.type = "checkbox";
  perm.style.minHeight = "0";
  permBox.append(perm, document.createTextNode(" Original endgültig löschen"));

  function currentValue() {
    return formatAddressList(
      rows
        .map((r) => ({ name: r.name.value.trim(), email: r.email.value.trim() }))
        .filter((r) => r.name || r.email)
    );
  }
  function updatePreview() {
    const v = currentValue();
    preview.textContent = `Neue Kopfzeile: To: ${v || "(leer)"}`;
    saveBtn.disabled = !v || v === msg.to.trim();
  }

  addBtn.onclick = () => {
    msg.recipients.list.push({ name: "", email: "" });
    msg.recipients.results.push({ findings: [], suggestion: null, ok: true });
    render();
  };
  saveBtn.onclick = async () => {
    if (state.busy) return;
    const value = currentValue();
    if (!value) return;
    state.busy = true;
    saveBtn.disabled = true;
    try {
      setStatus("Nachricht wird mit korrigierter Empfänger-Zeile neu abgelegt …");
      const { newId } = await rewriteHeaders(msg.id, { To: value }, { permanent: perm.checked });
      toast("Empfänger gespeichert — Nachricht wurde ersetzt.");
      const idx = state.msgs.indexOf(msg);
      const fresh = await loadMessage(newId);
      fresh.to = await rawHeader(newId, "To").catch(() => value);
      state.msgs[idx] = fresh;
      analyzeAll();
    } catch (e) {
      console.error(e);
      toast(`Speichern fehlgeschlagen: ${e.message}`, true);
    } finally {
      state.busy = false;
    }
  };

  actions.append(addBtn, saveBtn, permBox);
  sec.append(preview, actions);
  updatePreview();
  return sec;
}

// --- Anhänge ----------------------------------------------------------------

function renderAttachments(msg) {
  const sec = el("section", "block");
  sec.append(el("h3", null, "Anhänge"));
  if (!msg.attachments.length) {
    sec.append(el("div", "muted", "Keine Anhänge."));
  }
  msg.atts.items.forEach((item, i) => {
    const row = el("div", "att");
    const nameCol = el("div", "name");
    nameCol.append(el("div", null, item.name || "(ohne Dateinamen)"));
    nameCol.append(el("div", "meta", item.contentType || "unbekannter Typ"));
    for (const f of item.findings) nameCol.append(findingRow(f));
    if (!item.plausible) {
      const s = suggestName(msg.attachments[i], {
        subject: msg.header.subject,
        body: msg.text,
        date: msg.header.date,
      });
      const hint = el("div", "diff", `Besser wäre z. B.: ${s}`);
      nameCol.append(hint);
    }
    row.append(nameCol, el("div", "size", fmtSize(item.size)));
    sec.append(row);
  });
  for (const f of msg.atts.findings) sec.append(findingRow(f));
  return sec;
}

// --- Inhaltsvergleich -------------------------------------------------------

function renderCompare() {
  const box = $("#compare");
  const body = $("#compareBody");
  body.textContent = "";
  if (state.msgs.length < 2) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  // Paarvergleich wächst quadratisch — bei vielen Nachrichten nur die ersten
  // Paare zeigen, sonst steht die Oberfläche.
  const MAX_PAIRS = 120;
  let pairs = 0;
  if ((state.msgs.length * (state.msgs.length - 1)) / 2 > MAX_PAIRS) {
    body.append(
      el(
        "div",
        "muted",
        `Viele Nachrichten geladen — es werden die ersten ${MAX_PAIRS} Paare gezeigt. ` +
          "Für den Massenlauf ist die Duplikat-Ansicht oben gedacht."
      )
    );
  }
  for (let i = 0; i < state.msgs.length; i++) {
    for (let j = i + 1; j < state.msgs.length; j++) {
      if (++pairs > MAX_PAIRS) return;
      const a = state.msgs[i];
      const b = state.msgs[j];
      const cmp = compareTexts(a.text, b.text);
      const cls = classify(cmp.score);
      const row = el("div", "cmp");
      row.append(el("div", `score ${cls.key}`, `${Math.round(cmp.score * 100)} %`));
      const who = el("div", "who");
      who.append(
        el(
          "div",
          null,
          `${cls.label}: „${decodeHeaderValue(a.header.subject)}“ ↔ „${decodeHeaderValue(
            b.header.subject
          )}“`
        )
      );
      const facts = compareFacts(a.text, b.text);
      if (!facts.equal) {
        const labels = {
          amounts: "Beträge",
          ibans: "IBAN",
          dates: "Daten",
          docNumbers: "Belegnummern",
        };
        for (const [key, d] of Object.entries(facts.diff)) {
          who.append(
            el(
              "div",
              "diff",
              `${labels[key] || key}: nur links ${d.onlyA.join(", ") || "—"} · nur rechts ${
                d.onlyB.join(", ") || "—"
              }`
            )
          );
        }
      } else if (cmp.score >= 0.85) {
        who.append(el("div", "diff", "Beträge, IBAN, Daten und Belegnummern stimmen überein."));
      }
      if (cmp.onlyA.length || cmp.onlyB.length) {
        who.append(
          el(
            "div",
            "diff",
            `Wörter nur links: ${cmp.onlyA.slice(0, 12).join(", ") || "—"} | nur rechts: ${
              cmp.onlyB.slice(0, 12).join(", ") || "—"
            }`
          )
        );
      }
      row.append(who);
      body.append(row);
    }
  }
}

// ------------------------------------------------------------------- Einstieg

$("#btnSelection").onclick = loadSelection;
$("#btnBookSave").onclick = saveBook;
$("#btnBookSuggest").onclick = () => {
  let n = 0;
  for (const e of state.book) {
    if (e.preferred && !state.bookFix.get(e.email)) {
      state.bookFix.set(e.email, e.preferred);
      n++;
    }
    if (e.emailSuggestion && !state.bookFixEmail.get(e.email)) {
      state.bookFixEmail.set(e.email, e.emailSuggestion);
      n++;
    }
  }
  renderBook();
  toast(n ? `${n} Vorschläge eingetragen — bitte prüfen und speichern.` : "Nichts zu ergänzen.");
};
$("#btnBookOnlyWork").onclick = () => {
  state.bookOnlyWork = !state.bookOnlyWork;
  renderBook();
};
$("#btnAddProfile").onclick = () => {
  readProfileInputs();
  state.profiles.push({ id: String(Date.now()), preferredName: "", names: [], emails: [] });
  renderProfiles();
  $("#profileBox").open = true;
};
$("#btnSaveProfiles").onclick = saveProfiles;
$("#btnFromBook").onclick = profilesFromAddressBook;

$("#btnLightTable").onclick = () => {
  if (state.msgs.length < 2) {
    toast("Dafür müssen mindestens zwei Nachrichten geladen sein.", true);
    return;
  }
  openTableFor(state.msgs.map((m) => m.id));
};
$("#btnStart").onclick = () => startReview(state.review ? nextUndecided() : 0);
$("#folderSel").onchange = async (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt?._folder) return;
  state.review = null;
  await loadFolder(opt._folder);
};

// --- Maßstab: Kontextmenü (Rechtsklick auf die Übersicht) oder Klick auf die
//     Maßstab-Anzeige. Kein Auswahlfeld mehr — der Maßstab gehört zum Ordner,
//     nicht in die Werkzeugleiste.
const modeMenu = $("#modeMenu");
function openModeMenu(x, y) {
  modeMenu.classList.remove("hidden");
  modeMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 280))}px`;
  modeMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 220))}px`;
  for (const b of modeMenu.querySelectorAll("button")) {
    b.classList.toggle("aktiv", b.dataset.mode === state.mode);
  }
}
const closeModeMenu = () => modeMenu.classList.add("hidden");
$("#dupes").addEventListener("contextmenu", (ev) => {
  if (!state.headers.length) return;
  ev.preventDefault();
  openModeMenu(ev.clientX, ev.clientY);
});
$("#modeHint").addEventListener("click", (ev) => {
  const r = ev.target.getBoundingClientRect();
  openModeMenu(r.left, r.bottom + 4);
});
document.addEventListener("click", (ev) => {
  if (!modeMenu.contains(ev.target) && ev.target !== $("#modeHint")) closeModeMenu();
});
for (const b of modeMenu.querySelectorAll("button")) {
  b.onclick = () => {
    closeModeMenu();
    switchMode(b.dataset.mode);
  };
}

api.runtime.onMessage.addListener((m) => {
  if (m?.type === "refresh") loadSelection();
});

/**
 * Wählt den Ordner, der im Hauptfenster gerade offen ist, in der Liste aus
 * und liest ihn ein. Ohne das musste man ihn ein zweites Mal von Hand wählen,
 * obwohl er längst markiert war.
 */
async function adoptFolderFromMailTab(folder) {
  if (!folder) return false;
  const sel = $("#folderSel");
  const match = [...sel.options].find(
    (o) =>
      o._folder &&
      ((folder.id && o._folder.id === folder.id) ||
        (o._folder.path === folder.path &&
          (!folder.accountId || o._folder.accountId === folder.accountId)))
  );
  if (!match) return false;
  sel.value = match.value;
  await loadFolder(match._folder);
  return true;
}

(async function init() {
  await loadProfiles();
  await fillFolders();
  const pending = await api.runtime.sendMessage({ type: "getPending" }).catch(() => null);
  const adopted = await adoptFolderFromMailTab(pending?.folder);
  if (pending?.ids?.length) await loadIds(pending.ids);
  else if (!adopted) setStatus("Wähle einen Ordner oder markiere Nachrichten im Hauptfenster.");
})();
