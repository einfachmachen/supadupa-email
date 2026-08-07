// tool.js — Oberfläche: Nachrichten laden, prüfen, Empfänger reparieren.

import {
  parseAddressList,
  formatAddressList,
  formatAddress,
  decodeHeaderValue,
} from "../lib/mime.js";
import { checkRecipientList, deriveProfiles, profileNames } from "../lib/recipients.js";
import { checkAttachments, suggestName } from "../lib/attachments.js";
import { compareTexts, classify, compareFacts, htmlToText } from "../lib/similarity.js";
import {
  loadMessage,
  rewriteHeaders,
  rawHeader,
  listFolders,
  listMessages,
  contactPairs,
  messengerApi as api,
} from "../lib/messageStore.js";

const $ = (sel) => document.querySelector(sel);
const state = {
  msgs: [], // [{id, header, body, attachments, to, checks}]
  profiles: [],
  busy: false,
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
  const bad = state.msgs.filter((m) => !m.recipients.ok || m.recipients.empty).length;
  setStatus(
    `${state.msgs.length} Nachricht(en) geprüft · ` +
      (bad ? `${bad} mit Empfänger-Problem` : "Empfänger überall stimmig")
  );
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
  for (let i = 0; i < state.msgs.length; i++) {
    for (let j = i + 1; j < state.msgs.length; j++) {
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
  try {
    setStatus("Ordner wird gelesen …");
    const msgs = await listMessages(opt._folder);
    await loadIds(msgs.map((m) => m.id));
  } catch (err) {
    toast(`Ordner konnte nicht gelesen werden: ${err.message}`, true);
  }
};

api.runtime.onMessage.addListener((m) => {
  if (m?.type === "refresh") loadSelection();
});

(async function init() {
  await loadProfiles();
  await fillFolders();
  const pending = await api.runtime.sendMessage({ type: "getPending" }).catch(() => null);
  await loadIds(pending?.ids || []);
})();
