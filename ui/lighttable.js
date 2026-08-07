// lighttable.js — der Leuchttisch.
//
// Gestaltungsregel: Die lesbare E-Mail steht im Mittelpunkt. Alles andere ist
// zugeklappt, bis es gebraucht wird. Oben nur Datum und Betreff — ein Klick
// auf ein Datum schaltet die GANZE Ansicht auf diese Fassung um.

import { collectCandidates, pickDefaults, overlayLines } from "../lib/candidates.js";
import { assembleMessage } from "../lib/assemble.js";
import { describeJunk, clean, visualize } from "../lib/textclean.js";
import { decodeHeaderValue } from "../lib/mime.js";
import { checkRecipientList } from "../lib/recipients.js";
import {
  loadForLightTable,
  takePart,
  importAssembled,
  folderOf,
  deleteMessages,
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

function fmtDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.valueOf())
    ? "(kein Datum)"
    : d.toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Öffnet den Leuchttisch.
 * @param {number[]} ids
 * @param {{profiles:Array, onDone:Function, onStatus:Function, onToast:Function}} opts
 */
export async function openLightTable(ids, opts = {}) {
  const { profiles = [], onStatus = () => {}, onToast = () => {} } = opts;

  const copies = [];
  for (const id of ids) {
    onStatus(`Leuchttisch: lese ${copies.length + 1}/${ids.length} …`);
    copies.push(await loadForLightTable(id));
  }
  const byId = new Map(copies.map((c) => [c.id, c]));
  const cands = collectCandidates(copies, { profiles });
  const sel = pickDefaults(cands, { profiles, ctx: { date: copies[0]?.date } });

  const state = {
    mode: "lesen", // lesen | vergleich | original
    activeCopyId: null, // null = beste Fassung aus allen Kopien
  };

  const overlay = el("div", "lt-overlay");
  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
  };

  /**
   * Eine Kopie zur aktiven machen: Text, Betreff, Adressen, Datum und die
   * Anhang-Namen springen auf DEREN Stand. Das ist die Erwartung beim Klick
   * auf ein Datum — nicht nur der Text wechselt, sondern die ganze Fassung.
   */
  function adoptCopy(id) {
    state.activeCopyId = id;
    if (id === null) {
      Object.assign(sel, pickDefaults(cands, { profiles, ctx: { date: copies[0]?.date } }));
      render();
      return;
    }
    const c = byId.get(id);
    sel.subject = String(c.subject || "").replace(
      /^(\s*(re|aw|antw|fwd?|wg)\s*(\[\d+\])?\s*:\s*)+/i,
      ""
    );
    sel.from = c.from || "";
    sel.to = c.to || "";
    sel.cc = c.cc || "";
    sel.date = c.date || "";
    sel.bodyText = clean(c.bodyText || "");
    const variant = cands.bodies.find((b) => b.sources.includes(id));
    sel.bodyKey = variant?.key ?? sel.bodyKey;
    // Anhang-Namen: die Schreibweise DIESER Kopie bevorzugen, wo vorhanden
    for (const state2 of sel.attachments) {
      const att = cands.attachments.find((a) => a.key === state2.key);
      const own = att?.sources.find((s) => s.copyId === id && s.name);
      if (own) {
        state2.filename = own.name;
        state2.reason = `Name aus Kopie ${id}`;
      }
    }
    render();
  }

  // ------------------------------------------------------------------ Bau
  function render() {
    overlay.textContent = "";

    // ---- Kopfzeile: knapp, mit ausklappbarer Erklärung
    const head = el("div", "lt-head");
    const title = el("div", "lt-title");
    title.append(el("span", null, "Leuchttisch"));
    title.append(
      el(
        "span",
        "lt-sub",
        `${copies.length} Fassungen · ${cands.attachments.length} Anhänge · ` +
          `${cands.bodies.length} Textvarianten`
      )
    );
    const help = el("button", "chip", "Wie funktioniert das?");
    const helpBox = el("div", "lt-help hidden");
    helpBox.textContent =
      "Oben wählst du die Fassung (Datum). Der Text in der Mitte ist die " +
      "Grundlage der neuen Nachricht und direkt bearbeitbar. Die zugeklappten " +
      "Bereiche darunter enthalten Betreff, Adressen und die Anhänge aller " +
      "Kopien — dort kannst du je Bestandteil eine andere Fassung wählen. " +
      "Unten entsteht daraus eine neue Nachricht; die Ausgangs-Mails bleiben " +
      "erhalten, solange der Haken gesetzt ist.";
    help.onclick = () => helpBox.classList.toggle("hidden");
    const x = el("button", "ghost", "Schließen");
    x.onclick = close;
    head.append(title, help, x);
    overlay.append(head, helpBox);

    // ---- Fassungen: Datum ganz oben, klickbar
    const dateRow = el("div", "lt-versions");
    const mk = (id, label, sub) => {
      const chip = el("button", `lt-version${state.activeCopyId === id ? " on" : ""}`);
      chip.append(el("div", "d", label));
      if (sub) chip.append(el("div", "s", sub));
      chip.onclick = () => adoptCopy(id);
      return chip;
    };
    dateRow.append(mk(null, "beste Fassung", "aus allen Kopien zusammengesetzt"));
    for (const c of copies) {
      const rec = checkRecipientList(c.to, profiles);
      const marks = [];
      marks.push(`${(c.attachments || []).length} Anh.`);
      marks.push(rec.empty ? "kein Empfänger" : rec.ok ? "Empfänger ok" : "Empfänger unklar");
      if (describeJunk(c.bodyText)) marks.push("Zeichenmüll");
      dateRow.append(mk(c.id, fmtDate(c.date), marks.join(" · ")));
    }
    overlay.append(dateRow);

    // ---- Betreff: groß, direkt bearbeitbar
    const subjWrap = el("div", "lt-subject");
    const subjIn = document.createElement("input");
    subjIn.type = "text";
    subjIn.value = decodeHeaderValue(sel.subject || "");
    subjIn.placeholder = "Betreff";
    subjIn.addEventListener("input", () => {
      sel.subject = subjIn.value;
    });
    subjWrap.append(subjIn);
    if (cands.subjects.length > 1) {
      const alt = el("div", "chips");
      for (const s of cands.subjects) {
        const c = el("button", "chip", decodeHeaderValue(s.value) || "(leer)");
        c.title = `aus Kopie ${s.sources.join(", ")}`;
        c.onclick = () => {
          sel.subject = s.value;
          subjIn.value = decodeHeaderValue(s.value);
        };
        alt.append(c);
      }
      subjWrap.append(alt);
    }
    overlay.append(subjWrap);

    // ---- Der Text: der größte Platz auf dem Schirm
    const main = el("div", "lt-main");
    const modes = el("div", "lt-modes");
    const modeBtn = (key, label, title) => {
      const b = el("button", `chip${state.mode === key ? " suggest" : ""}`, label);
      b.title = title;
      b.onclick = () => {
        state.mode = key;
        render();
      };
      return b;
    };
    modes.append(
      modeBtn("lesen", "Lesen", "Gesäuberter Text, ohne Markierungen — so wird er gespeichert."),
      modeBtn("vergleich", "Vergleich", "Alle Fassungen überlagert, Unterschiede farbig."),
      modeBtn("original", "Original", "Rohtext der aktiven Fassung, Steuerzeichen sichtbar gemacht.")
    );
    const junk = state.activeCopyId
      ? describeJunk(byId.get(state.activeCopyId).bodyText)
      : "";
    if (junk) modes.append(el("span", "lt-junk", `entfernt: ${junk}`));
    main.append(modes);

    if (state.mode === "vergleich") {
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
      main.append(light);
      const legend = el("div", "lt-legend");
      legend.append(
        el("span", "l-all", "in allen Fassungen"),
        el("span", "l-some", "in mehreren"),
        el("span", "l-one", "nur in einer")
      );
      main.append(legend);
      if (cands.bodies.length > 1) {
        const pick = el("div", "chips");
        cands.bodies.forEach((b, i) => {
          const chip = el(
            "button",
            `chip${b.key === sel.bodyKey ? " suggest" : ""}`,
            `Fassung ${i + 1} übernehmen (Kopie ${b.sources.join(", ")})`
          );
          chip.onclick = () => {
            sel.bodyKey = b.key;
            sel.bodyText = b.cleaned;
            state.mode = "lesen";
            render();
          };
          pick.append(chip);
        });
        main.append(pick);
      }
    } else if (state.mode === "original") {
      const src = state.activeCopyId
        ? byId.get(state.activeCopyId).bodyText
        : cands.bodies.find((b) => b.key === sel.bodyKey)?.value || sel.bodyText;
      const pre = el("div", "lt-light lt-raw", visualize(src));
      main.append(pre);
      main.append(
        el(
          "div",
          "lt-legend",
          "⌷ Zero-Width · ␣ geschütztes Leerzeichen · ¬ bedingter Trennstrich · ␦ Steuerzeichen · ⇄ Schreibrichtung · ◆ Ersatzzeichen"
        )
      );
    } else {
      const area = document.createElement("textarea");
      area.className = "lt-read";
      area.value = sel.bodyText || "";
      area.spellcheck = false;
      area.addEventListener("input", () => {
        sel.bodyText = area.value;
      });
      main.append(area);
    }
    overlay.append(main);

    // ---- Alles Weitere: zugeklappt
    const details = el("div", "lt-details");
    details.append(
      foldable(
        "Empfänger & Absender",
        summaryFor("recipients"),
        () => [
          candidatePanel("Empfänger (To)", cands.tos, () => sel.to, (v) => (sel.to = v), {
            editable: true,
          }),
          candidatePanel("Kopie (Cc)", cands.ccs, () => sel.cc, (v) => (sel.cc = v), {
            editable: true,
            allowEmpty: true,
          }),
          candidatePanel("Absender (From)", cands.froms, () => sel.from, (v) => (sel.from = v), {
            editable: true,
          }),
        ],
        needsAttention("recipients")
      ),
      foldable(
        `Anhänge (${cands.attachments.length})`,
        summaryFor("attachments"),
        () => [attachmentPanel()],
        needsAttention("attachments")
      ),
      foldable("Datum", fmtDate(sel.date), () => [datePanel()], false)
    );
    overlay.append(details);

    // ---- Fußleiste
    overlay.append(actionBar());
  }

  // -------------------------------------------------------------- Bausteine

  function needsAttention(what) {
    if (what === "recipients") {
      const res = checkRecipientList(sel.to, profiles);
      return res.empty || !res.ok;
    }
    if (what === "attachments") {
      return sel.attachments.some((a) => a.reason && /gebildet|keinen Namen/.test(a.reason));
    }
    return false;
  }

  function summaryFor(what) {
    if (what === "recipients") {
      const res = checkRecipientList(sel.to, profiles);
      if (res.empty) return "kein Empfänger gewählt";
      return decodeHeaderValue(sel.to) + (res.ok ? "" : " — prüfen");
    }
    if (what === "attachments") {
      const on = sel.attachments.filter((a) => a.include).length;
      const renamed = sel.attachments.filter((a) => /gebildet|Kopie|keinen Namen/.test(a.reason || "")).length;
      return `${on} von ${sel.attachments.length} ausgewählt${renamed ? `, ${renamed} umbenannt` : ""}`;
    }
    return "";
  }

  function foldable(title, summaryText, buildChildren, warn) {
    const box = document.createElement("details");
    box.className = `lt-fold${warn ? " warn" : ""}`;
    const sum = document.createElement("summary");
    sum.append(el("span", "t", title));
    sum.append(el("span", "s", summaryText));
    if (warn) sum.append(el("span", "badge warn", "prüfen"));
    box.append(sum);
    let built = false;
    box.addEventListener("toggle", () => {
      if (box.open && !built) {
        built = true;
        for (const child of buildChildren()) box.append(child);
      }
    });
    return box;
  }

  function candidatePanel(title, list, getValue, setValue, o = {}) {
    const panel = el("div", "lt-panel");
    panel.append(el("h3", null, title));
    if (!list.length) panel.append(el("div", "muted", "— nichts vorhanden —"));

    const cards = [];
    let edit = null;
    const select = (value, card) => {
      setValue(value);
      cards.forEach((c) => c.classList.toggle("on", c === card));
      if (edit) edit.value = value;
    };

    for (const v of list) {
      const card = el("div", "cand");
      card.append(el("div", "val", decodeHeaderValue(v.value) || "— leer —"));
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
      if (v.value === getValue() || v.suggestion === getValue()) card.classList.add("on");
      cards.push(card);
      panel.append(card);
    }

    if (o.editable) {
      edit = document.createElement("input");
      edit.type = "text";
      edit.value = getValue() || "";
      edit.placeholder = o.allowEmpty ? "leer lassen ist ok" : "Name <adresse@beispiel.de>";
      edit.addEventListener("input", () => {
        setValue(edit.value.trim());
        cards.forEach((c) => c.classList.remove("on"));
      });
      panel.append(el("div", "src", "oder von Hand:"), edit);
    }
    return panel;
  }

  function attachmentPanel() {
    const panel = el("div", "lt-panel");
    if (!cands.attachments.length) panel.append(el("div", "muted", "Keine Anhänge."));
    for (const att of cands.attachments) {
      const st = sel.attachments.find((x) => x.key === att.key);
      const row = el("div", `lt-att${st.include ? "" : " off"}`);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = st.include;
      box.style.minHeight = "0";
      box.onchange = () => {
        st.include = box.checked;
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
      nameIn.value = st.filename;
      nameIn.addEventListener("input", () => {
        st.filename = nameIn.value.trim();
      });
      body.append(nameIn, el("div", "meta", st.reason || ""));
      if (att.names.length > 1) {
        const chips = el("div", "chips");
        for (const n of att.names) {
          const c = el("button", "chip", n);
          c.onclick = () => {
            st.filename = n;
            nameIn.value = n;
          };
          chips.append(c);
        }
        body.append(chips);
      }
      row.append(box, body);
      panel.append(row);
    }
    return panel;
  }

  function datePanel() {
    const panel = el("div", "lt-panel");
    for (const d of cands.dates) {
      const card = el("div", `cand${d.value === sel.date ? " on" : ""}`);
      card.append(el("div", "val", fmtDate(d.value)));
      card.append(el("div", "src", `aus Kopie ${d.sources.join(", ")}`));
      card.onclick = () => {
        sel.date = d.value;
        [...panel.children].forEach((c) => c.classList?.remove("on"));
        card.classList.add("on");
      };
      panel.append(card);
    }
    return panel;
  }

  function actionBar() {
    const bar = el("div", "lt-actionbar");
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
        for (const st of sel.attachments) {
          if (!st.include) continue;
          const att = cands.attachments.find((a) => a.key === st.key);
          const source = att.sources[0];
          const part = takePart(byId.get(source.copyId), source.index);
          attachments.push({
            ...part,
            filenameOriginal: part.filename,
            filename: st.filename || part.filename,
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
            (keepBox.checked ? " — Ausgangs-Mails unverändert." : " — Ausgangs-Mails im Papierkorb.")
        );
        close();
        opts.onDone?.({ newId: imported.id, removed: keepBox.checked ? [] : ids });
      } catch (e) {
        console.error(e);
        onToast(`Erzeugen fehlgeschlagen: ${e.message}`, true);
        build.disabled = false;
      }
    };

    bar.append(keep, build);
    return bar;
  }

  render();
  onStatus(`Leuchttisch offen · ${copies.length} Fassungen`);
}
