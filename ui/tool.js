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
} from "../lib/recipients.js";
import {
  groupDuplicates,
  summarize,
  removableIds,
  verifyGroup,
  MODES,
} from "../lib/dedupe.js";
import { buildMergePlan } from "../lib/merge.js";
import { checkAttachments, suggestName } from "../lib/attachments.js";
import { compareTexts, classify, compareFacts, htmlToText } from "../lib/similarity.js";
import {
  loadMessage,
  rewriteHeaders,
  rawHeader,
  listFolders,
  listAllMessages,
  deleteMessages,
  mergeParts,
  mergeGroup,
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
  mode: MODES.normal,
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
      field("emails", "Adressen (Komma)", (p.emails || []).join(", "))
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
  if (!ids.length) {
    const pending = await api.runtime.sendMessage({ type: "getPending" }).catch(() => null);
    ids = pending?.ids || [];
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
  render();
  updateBulkFixButton();
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
    regroup();
  } catch (e) {
    console.error(e);
    toast(`Ordner konnte nicht gelesen werden: ${e.message}`, true);
    setStatus("Fehler beim Lesen des Ordners.");
  } finally {
    state.busy = false;
  }
}

function regroup() {
  state.groups = groupDuplicates(state.headers, {
    mode: state.mode,
    profiles: state.profiles,
  });
  const s = summarize(state.groups);
  setStatus(
    `${state.headers.length} Nachrichten · ${s.groups} Duplikat-Gruppen · ` +
      `${s.removable} entfernbare Kopien`
  );
  renderGroups();
  render();
}

function renderGroups() {
  const box = $("#dupes");
  const body = $("#dupesBody");
  body.textContent = "";
  if (!state.headers.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  const s = summarize(state.groups);
  $("#dupeSummary").textContent = s.groups
    ? `${s.groups} Gruppen, ${s.removable} Kopien könnten weg. Pro Gruppe ist die beste Kopie vorausgewählt — die mit der vollständigsten Empfänger-Angabe.`
    : "Keine Duplikate nach dem aktuellen Maßstab gefunden.";
  $("#btnDeleteAll").disabled = !s.removable;
  $("#btnDeleteAll").textContent = `Alle ${s.removable} Duplikate in den Papierkorb`;
  $("#btnKeepers").disabled = !s.groups;

  const shown = state.groups.slice(0, 200);
  for (const g of shown) body.append(renderGroup(g));
  if (state.groups.length > shown.length) {
    body.append(
      el(
        "div",
        "muted",
        `… ${state.groups.length - shown.length} weitere Gruppen (werden beim Löschen mitbehandelt).`
      )
    );
  }
}

function renderGroup(g) {
  const card = el("div", "card");
  const first = g.messages[0];
  const head = el("div", "subject");
  head.append(el("div", null, decodeHeaderValue(first.subject) || "(kein Betreff)"));
  head.append(
    el(
      "div",
      "meta",
      `${decodeHeaderValue(first.author || "")} · ${new Date(first.date).toLocaleString("de-DE")}`
    )
  );
  card.append(head);

  const badges = el("div", "badges");
  badges.append(el("span", "badge warn", `${g.messages.length} Kopien`));
  badges.append(
    el(
      "span",
      `badge ${g.verified ? "ok" : ""}`,
      g.verified ? "Inhalt identisch (geprüft)" : "Inhalt ungeprüft"
    )
  );
  for (const r of g.reasons) badges.append(el("span", "badge", r));
  card.append(badges);

  const sec = el("section", "block");
  for (const m of g.messages) {
    const row = el("div", "att");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `keep-${g.key}`;
    radio.checked = m.id === g.keeperId;
    radio.style.minHeight = "0";
    radio.onchange = () => {
      g.keeperId = m.id;
      renderGroups();
    };
    const info = el("div", "name");
    const to = (m.recipients || []).join(", ");
    info.append(el("div", null, to ? decodeHeaderValue(to) : "— keine Empfänger-Angabe —"));
    info.append(
      el(
        "div",
        "meta",
        `${new Date(m.date).toLocaleString("de-DE")} · ${m.folder?.path || ""} · Punkte ${
          g.scores[m.id]
        }${m.id === g.keeperId ? " · bleibt" : ""}`
      )
    );
    const open = el("button", "chip", "öffnen & prüfen");
    open.onclick = () => loadIds([m.id]);
    row.append(radio, info, el("div", "size", fmtSize(m.size)), open);
    sec.append(row);
  }

  const bar = el("div", "bar");
  const verify = el("button", "ghost", g.verified ? "Inhalt geprüft ✓" : "Inhalte prüfen");
  verify.disabled = Boolean(g.verified);
  verify.onclick = () => verifyOneGroup(g);
  const merge = el("button", "primary", "Zu einer vollständigen Mail zusammenführen");
  merge.onclick = () => mergeOneGroup(g);
  bar.append(verify, merge);
  const del = el("button", "danger", `${g.messages.length - 1} Duplikate löschen`);
  del.onclick = async () => {
    const ids = removableIds(g);
    if (!ids.length) return;
    await runDelete(ids, `${ids.length} Kopie(n)`);
    state.headers = state.headers.filter((h) => !ids.includes(h.id));
    regroup();
  };
  bar.append(del);
  sec.append(bar);
  card.append(sec);
  return card;
}

/**
 * Lädt die Inhalte einer Gruppe und teilt sie anhand der Inhalts-Prüfsumme
 * auf — erst danach ist „das ist wirklich dieselbe Nachricht“ belastbar.
 */
async function verifyOneGroup(g) {
  const contents = new Map();
  for (const m of g.messages) {
    setStatus(`Prüfe Inhalte … ${contents.size + 1}/${g.messages.length}`);
    try {
      const full = await loadMessage(m.id);
      contents.set(m.id, {
        bodyText: bodyText(full),
        attachments: full.attachments,
      });
      m._loaded = full;
    } catch (e) {
      console.warn("Inhalt nicht lesbar", m.id, e);
    }
  }
  const parts = verifyGroup(g, contents);
  const at = state.groups.indexOf(g);
  state.groups.splice(at, 1, ...parts);
  const dropped = g.messages.length - parts.reduce((n, p) => n + p.messages.length, 0);
  renderGroups();
  toast(
    dropped
      ? `Inhalte geprüft: ${dropped} Nachricht(en) waren KEINE Dublette und sind aus der Gruppe raus.`
      : "Inhalte geprüft: alle Kopien sind inhaltlich identisch."
  );
  setStatus(`${state.groups.length} Gruppen`);
}

/** Baut aus einer Gruppe eine vollständige Nachricht und ersetzt die Kopien. */
async function mergeOneGroup(g) {
  if (state.busy) return;
  state.busy = true;
  try {
    setStatus("Kopien werden gelesen …");
    const copies = [];
    for (const m of g.messages) {
      const full = m._loaded || (await loadMessage(m.id));
      m._loaded = full;
      copies.push({
        id: m.id,
        to: full.to || "",
        cc: full.cc || "",
        size: m.size || 0,
        attachments: full.attachments,
        header: full.header,
      });
    }

    // Grundlage bestimmen und deren echte MIME-Teile holen
    const provisional = buildMergePlan({ copies, profiles: state.profiles, baseParts: [], ctx: {} });
    const baseCopy = copies.find((c) => c.id === provisional.baseId) || copies[0];
    const baseFull = g.messages.find((m) => m.id === baseCopy.id)._loaded;
    const { parts } = await mergeParts(baseCopy.id);

    const plan = buildMergePlan({
      copies,
      profiles: state.profiles,
      baseParts: parts,
      baseId: baseCopy.id,
      ctx: {
        subject: baseFull.header.subject,
        body: bodyText(baseFull),
        date: baseFull.header.date,
      },
    });

    const text =
      "Aus den Kopien wird EINE vollständige Nachricht gebaut:\n\n" +
      plan.notes.map((n) => `• ${n}`).join("\n") +
      `\n\nDanach werden die ${plan.removableIds.length} bisherigen Kopien ` +
      (($("#permDelete").checked && "ENDGÜLTIG gelöscht") || "in den Papierkorb verschoben") +
      ".\n\nFortfahren?";
    if (!window.confirm(text)) return;

    setStatus("Vollständige Nachricht wird abgelegt …");
    const { newId } = await mergeGroup({
      baseId: plan.baseId,
      headers: plan.headers,
      renames: plan.renames,
      deleteIds: plan.removableIds,
      permanent: $("#permDelete").checked,
    });

    const gone = new Set(plan.removableIds);
    state.headers = state.headers.filter((h) => !gone.has(h.id));
    state.groups = state.groups.filter((x) => x !== g);
    renderGroups();
    toast("Zusammengeführt — die neue Nachricht liegt im selben Ordner.");
    await loadIds([newId]);
  } catch (e) {
    console.error(e);
    toast(`Zusammenführen fehlgeschlagen: ${e.message}`, true);
  } finally {
    state.busy = false;
  }
}

async function mergeAllGroups() {
  const groups = [...state.groups];
  if (!groups.length) return;
  if (
    !window.confirm(
      `${groups.length} Gruppen werden nacheinander zu je einer vollständigen ` +
        "Nachricht zusammengeführt. Jede Gruppe zeigt vorher ihren Plan; mit " +
        "„Abbrechen“ überspringst du sie. Starten?"
    )
  ) {
    return;
  }
  for (const g of groups) {
    if (!state.groups.includes(g)) continue;
    await mergeOneGroup(g);
  }
}

async function runDelete(ids, label) {
  const permanent = $("#permDelete").checked;
  const where = permanent ? "ENDGÜLTIG gelöscht" : "in den Papierkorb verschoben";
  if (!window.confirm(`${label} werden ${where}. Fortfahren?`)) return false;
  state.busy = true;
  try {
    await deleteMessages(ids, {
      permanent,
      onProgress: (done, total) => setStatus(`Lösche … ${done}/${total}`),
    });
    toast(`${ids.length} Nachricht(en) ${where}.`);
    return true;
  } catch (e) {
    console.error(e);
    toast(`Löschen fehlgeschlagen: ${e.message}`, true);
    return false;
  } finally {
    state.busy = false;
  }
}

async function deleteAllDupes() {
  const ids = state.groups.flatMap(removableIds);
  if (!ids.length) return;
  const ok = await runDelete(ids, `${ids.length} Duplikate aus ${state.groups.length} Gruppen`);
  if (!ok) return;
  const gone = new Set(ids);
  state.headers = state.headers.filter((h) => !gone.has(h.id));
  regroup();
}

/** Lädt die Kopien, die bleiben sollen, zur Empfänger-Korrektur in die Liste. */
async function loadKeepers() {
  const ids = state.groups.map((g) => g.keeperId).slice(0, 50);
  if (!ids.length) return;
  await loadIds(ids);
  updateBulkFixButton();
}

function pendingFixes() {
  return state.msgs
    .map((m) => ({ msg: m, value: applySuggestions(m.to, state.profiles) }))
    .filter((x) => x.value && x.value !== (x.msg.to || "").trim());
}

function updateBulkFixButton() {
  const n = pendingFixes().length;
  const btn = $("#btnFixAll");
  btn.disabled = !n;
  btn.textContent = n
    ? `Empfänger in ${n} Nachricht(en) korrigieren`
    : "Keine automatischen Korrekturen offen";
}

async function fixAllRecipients() {
  const fixes = pendingFixes();
  if (!fixes.length) return;
  if (
    !window.confirm(
      `${fixes.length} Nachricht(en) bekommen eine neue Empfänger-Zeile.\n\n` +
        "Jede wird dabei neu abgelegt (Original in den Papierkorb). Fortfahren?"
    )
  ) {
    return;
  }
  state.busy = true;
  let done = 0;
  const failed = [];
  for (const { msg, value } of fixes) {
    try {
      setStatus(`Korrigiere … ${done + 1}/${fixes.length}`);
      await rewriteHeaders(msg.id, { To: value }, { permanent: false });
      done++;
    } catch (e) {
      console.error(e);
      failed.push(`${decodeHeaderValue(msg.header.subject)}: ${e.message}`);
    }
  }
  state.busy = false;
  toast(
    failed.length
      ? `${done} korrigiert, ${failed.length} fehlgeschlagen (Details in der Konsole).`
      : `${done} Nachricht(en) korrigiert.`,
    failed.length > 0
  );
  if (failed.length) console.error("Fehlgeschlagen:", failed);
  if (state.folder) await loadFolder(state.folder);
}

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
$("#btnReload").onclick = () => analyzeAll();
$("#btnAddProfile").onclick = () => {
  readProfileInputs();
  state.profiles.push({
    id: String(Date.now()),
    preferredName: "",
    names: [],
    emails: [],
  });
  renderProfiles();
  $("#profileBox").open = true;
};
$("#btnSaveProfiles").onclick = saveProfiles;
$("#btnFromBook").onclick = profilesFromAddressBook;
$("#folderSel").onchange = async (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt?._folder) return;
  await loadFolder(opt._folder);
};
$("#modeSel").onchange = (e) => {
  state.mode = e.target.value;
  if (state.headers.length) regroup();
};
$("#btnDeleteAll").onclick = deleteAllDupes;
$("#btnMergeAll").onclick = mergeAllGroups;
$("#btnKeepers").onclick = loadKeepers;
$("#btnFixAll").onclick = fixAllRecipients;

api.runtime.onMessage.addListener((m) => {
  if (m?.type === "refresh") loadSelection();
});

(async function init() {
  await loadProfiles();
  await fillFolders();
  const pending = await api.runtime.sendMessage({ type: "getPending" }).catch(() => null);
  await loadIds(pending?.ids || []);
})();
