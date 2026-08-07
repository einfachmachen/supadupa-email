// lighttable.js — der Leuchttisch: mehrere zusammengehörige Kopien
// übereinandergelegt, ringsum die Bestandteile zur Auswahl, unten der Knopf,
// der daraus EINE neue, richtige Nachricht baut.

import { collectCandidates, pickDefaults, overlayLines } from "../lib/candidates.js";
import { assembleMessage } from "../lib/assemble.js";
import { describeJunk, clean } from "../lib/textclean.js";
import { decodeHeaderValue } from "../lib/mime.js";
import {
  loadForLightTable,
  takePart,
  importAssembled,
  folderOf,
  deleteMessages,
  messengerApi as api,
} from "../lib/messageStore.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/**
 * Öffnet den Leuchttisch für eine Gruppe von Nachrichten-IDs.
 * @param {number[]} ids
 * @param {{profiles:Array, onDone:(info)=>void, onStatus:(s)=>void, onToast:(s,err)=>void}} opts
 */
export async function openLightTable(ids, opts = {}) {
  const { profiles = [], onStatus = () => {}, onToast = () => {} } = opts;
  onStatus(`Leuchttisch: ${ids.length} Kopien werden gelesen …`);

  const copies = [];
  for (const id of ids) {
    onStatus(`Leuchttisch: lese ${copies.length + 1}/${ids.length} …`);
    copies.push(await loadForLightTable(id));
  }

  const cands = collectCandidates(copies, { profiles });
  const sel = pickDefaults(cands, { profiles, ctx: { date: copies[0]?.date } });
  const byId = new Map(copies.map((c) => [c.id, c]));

  const overlay = el("div", "lt-overlay");
  const grid = el("div", "lt-grid");
  overlay.append(grid);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
  };

  // ------------------------------------------------------------------ Kopf
  const top = el("div", "lt-panel lt-top");
  top.append(el("h3", null, `Leuchttisch · ${copies.length} Kopien überlagert`));
  const lead = el("div", "muted");
  lead.textContent =
    "Wähle je Bestandteil die richtige Fassung. Links Kopfdaten, rechts die " +
    "Anhänge aller Kopien, in der Mitte der überlagerte Text. Unten entsteht " +
    "daraus eine neue Nachricht.";
  top.append(lead);
  const junkNote = copies
    .map((c) => ({ id: c.id, junk: describeJunk(c.bodyText) }))
    .filter((x) => x.junk);
  if (junkNote.length) {
    const w = el("div", "diff");
    w.style.color = "var(--gold)";
    w.textContent =
      "Zeichenmüll gefunden — beim Vergleich ignoriert, im neuen Text entfernt: " +
      junkNote.map((x) => `Kopie ${x.id} (${x.junk})`).join(" · ");
    top.append(w);
  }
  grid.append(top);

  // ------------------------------------------------------- Linke Spalte
  const left = el("div");
  left.append(
    candidatePanel("Betreff", cands.subjects, sel.subject, (v) => {
      sel.subject = v;
    }),
    candidatePanel("Absender (From)", cands.froms, sel.from, (v) => {
      sel.from = v;
    }),
    candidatePanel("Empfänger (To)", cands.tos, sel.to, (v) => {
      sel.to = v;
    }, { editable: true }),
    candidatePanel("Kopie (Cc)", cands.ccs, sel.cc, (v) => {
      sel.cc = v;
    }, { editable: true, allowEmpty: true }),
    candidatePanel("Datum", cands.dates, sel.date, (v) => {
      sel.date = v;
    })
  );
  grid.append(left);

  // ------------------------------------------------------------- Mitte
  const center = el("div", "lt-panel");
  center.append(el("h3", null, "Text — alle Fassungen überlagert"));
  const legend = el("div", "lt-legend");
  legend.append(
    el("span", null, "■ in allen Fassungen"),
    el("span", null, "■ in mehreren, nicht allen"),
    el("span", null, "■ nur in einer")
  );
  legend.children[0].style.color = "var(--txt)";
  legend.children[1].style.color = "var(--gold)";
  legend.children[2].style.color = "var(--txt2)";
  center.append(legend);

  const light = el("div", "lt-light");
  const lines = overlayLines(cands.bodies);
  for (const line of lines) {
    const cls =
      line.sources.length === cands.bodies.length
        ? "all"
        : line.sources.length > 1
        ? "some"
        : "one";
    const row = el("div", `lt-line ${cls}`, line.text || " ");
    row.title = `in ${line.sources.length} von ${cands.bodies.length} Fassungen`;
    light.append(row);
  }
  center.append(light);

  const pickRow = el("div", "chips");
  cands.bodies.forEach((b, i) => {
    const chip = el(
      "button",
      `chip${b.key === sel.bodyKey ? " suggest" : ""}`,
      `Fassung ${i + 1} übernehmen (Kopie ${b.sources.join(", ")})${b.junk ? " ⚠" : ""}`
    );
    chip.onclick = () => {
      sel.bodyKey = b.key;
      sel.bodyText = b.cleaned;
      textEdit.value = b.cleaned;
      [...pickRow.children].forEach((c, j) =>
        c.classList.toggle("suggest", j === i)
      );
    };
    pickRow.append(chip);
  });
  center.append(pickRow);

  const textEdit = document.createElement("textarea");
  textEdit.className = "lt-textedit";
  textEdit.value = sel.bodyText || "";
  textEdit.addEventListener("input", () => {
    sel.bodyText = textEdit.value;
  });
  center.append(el("h3", null, "Text der neuen Nachricht (bearbeitbar)"), textEdit);
  grid.append(center);

  // ------------------------------------------------------ Rechte Spalte
  const right = el("div", "lt-panel");
  right.append(el("h3", null, `Anhänge aus allen Kopien (${cands.attachments.length})`));
  if (!cands.attachments.length) right.append(el("div", "muted", "Keine Anhänge."));
  cands.attachments.forEach((att) => {
    const state = sel.attachments.find((x) => x.key === att.key);
    const row = el("div", "lt-att");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.include;
    box.style.minHeight = "0";
    box.onchange = () => {
      state.include = box.checked;
      row.classList.toggle("off", !box.checked);
    };
    const body = el("div", "body");
    body.append(
      el(
        "div",
        "meta",
        `${att.contentType || "unbekannt"} · ${fmtSize(att.size)} · in Kopie ` +
          `${[...new Set(att.sources.map((s) => s.copyId))].join(", ")}`
      )
    );
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = state.filename;
    nameIn.addEventListener("input", () => {
      state.filename = nameIn.value.trim();
    });
    body.append(nameIn);
    body.append(el("div", "meta", state.reason));
    if (att.names.length > 1) {
      const chips = el("div", "chips");
      for (const n of att.names) {
        const c = el("button", "chip", n);
        c.onclick = () => {
          state.filename = n;
          nameIn.value = n;
        };
        chips.append(c);
      }
      body.append(chips);
    }
    row.append(box, body);
    right.append(row);
  });
  grid.append(right);

  // ------------------------------------------------------------- Fußleiste
  const bar = el("div", "lt-actionbar");
  const cancel = el("button", "ghost", "Schließen");
  cancel.onclick = close;
  const keep = document.createElement("label");
  keep.className = "muted";
  const keepBox = document.createElement("input");
  keepBox.type = "checkbox";
  keepBox.checked = true;
  keepBox.style.minHeight = "0";
  keep.append(keepBox, document.createTextNode(" Ausgangs-Mails behalten"));
  const build = el("button", "primary", "Neue Nachricht erzeugen");

  build.onclick = async () => {
    build.disabled = true;
    try {
      onStatus("Neue Nachricht wird gebaut …");
      const attachments = [];
      for (const state of sel.attachments) {
        if (!state.include) continue;
        const att = cands.attachments.find((a) => a.key === state.key);
        const source = att.sources[0];
        const loaded = byId.get(source.copyId);
        const part = takePart(loaded, source.index);
        attachments.push({
          ...part,
          filenameOriginal: part.filename,
          filename: state.filename || part.filename,
        });
      }

      const bytes = assembleMessage({
        headers: {
          from: sel.from,
          to: sel.to,
          cc: sel.cc,
          subject: sel.subject,
          date: sel.date,
          extra: { "X-SupaDupa-Merged-From": ids.join(",") },
        },
        bodyText: clean(sel.bodyText),
        attachments,
      });

      const folder = await folderOf(byId.get(ids[0]).header);
      const imported = await importAssembled(bytes, folder);
      if (!keepBox.checked) {
        await deleteMessages(ids.filter((id) => id !== imported.id), { permanent: false });
      }
      onToast(
        `Neue Nachricht abgelegt (${attachments.length} Anhänge)` +
          (keepBox.checked ? " — die Ausgangs-Mails sind unverändert." : " — Ausgangs-Mails im Papierkorb.")
      );
      close();
      opts.onDone?.({ newId: imported.id, removed: keepBox.checked ? [] : ids });
    } catch (e) {
      console.error(e);
      onToast(`Erzeugen fehlgeschlagen: ${e.message}`, true);
      build.disabled = false;
    }
  };

  bar.append(cancel, keep, build);
  overlay.append(bar);
  onStatus(`Leuchttisch offen · ${copies.length} Kopien`);

  // -------------------------------------------------------------- Helfer
  function candidatePanel(title, list, initial, onPick, o = {}) {
    const panel = el("div", "lt-panel");
    panel.style.marginBottom = "12px";
    panel.append(el("h3", null, title));
    if (!list.length) panel.append(el("div", "muted", "— nichts vorhanden —"));

    const cards = [];
    const select = (value, card) => {
      onPick(value);
      cards.forEach((c) => c.classList.toggle("on", c === card));
      if (o.editable && edit) edit.value = value;
    };

    for (const v of list) {
      const card = el("div", "cand");
      const shown = title.startsWith("Betreff") || title.startsWith("Absender")
        ? decodeHeaderValue(v.value)
        : v.value;
      card.append(el("div", "val", shown || "— leer —"));
      card.append(el("div", "src", `aus Kopie ${v.sources.join(", ")}`));
      for (const issue of v.issues || []) card.append(el("div", "bad", issue));
      if (v.suggestion) {
        const s = el("button", "chip suggest", `korrigiert: ${v.suggestion}`);
        s.onclick = (ev) => {
          ev.stopPropagation();
          select(v.suggestion, card);
        };
        card.append(s);
      }
      card.onclick = () => select(v.value, card);
      if (v.value === initial || v.suggestion === initial) card.classList.add("on");
      cards.push(card);
      panel.append(card);
    }

    let edit = null;
    if (o.editable) {
      edit = document.createElement("input");
      edit.type = "text";
      edit.value = initial || "";
      edit.placeholder = o.allowEmpty ? "leer lassen ist ok" : "Name <adresse@beispiel.de>";
      edit.addEventListener("input", () => {
        onPick(edit.value.trim());
        cards.forEach((c) => c.classList.remove("on"));
      });
      panel.append(el("div", "src", "oder von Hand:"), edit);
    }
    return panel;
  }
}
