// review.js — der Durchgang: einmal durch alle Gruppen, markieren, am Ende
// entscheiden.
//
// Grundsatz: **Im Durchgang wird nichts verändert.** Es entstehen nur
// Vormerkungen. Erst die Zusammenfassung am Ende führt sie aus — bis dahin ist
// jede Entscheidung folgenlos zurücknehmbar.

export const MARKS = {
  merge: "merge", // zusammenfassen
  delete: "delete", // löschen
  later: "later", // später nochmal prüfen
  none: "none", // noch nicht entschieden
};

export const MARK_LABELS = {
  merge: "Zusammenfassen",
  delete: "Löschen",
  later: "Später prüfen",
  none: "Ohne Vormerkung",
};

/**
 * Legt einen Durchgang über die gefundenen Gruppen an.
 * @param {Array<{key:string, messages:Array}>} groups
 * @param {{marks?:Record<string,string>}} state vorheriger Stand (z. B. aus storage)
 */
export function createReview(groups, { marks = {} } = {}) {
  return {
    groups: [...(groups || [])],
    marks: { ...marks },
    index: 0,
  };
}

/** Vormerkung setzen (oder mit demselben Wert wieder aufheben). */
export function setMark(review, key, mark) {
  const next = { ...review.marks };
  if (!mark || mark === MARKS.none || next[key] === mark) delete next[key];
  else next[key] = mark;
  return { ...review, marks: next };
}

export function markOf(review, key) {
  return review.marks[key] || MARKS.none;
}

/** Nächste Gruppe — wahlweise nur solche ohne Vormerkung. */
export function nextIndex(review, { onlyUnmarked = false, from = review.index } = {}) {
  for (let i = from + 1; i < review.groups.length; i++) {
    if (!onlyUnmarked || markOf(review, review.groups[i].key) === MARKS.none) return i;
  }
  return -1;
}

export function prevIndex(review, { from = review.index } = {}) {
  return from > 0 ? from - 1 : -1;
}

/** Zahlen für die Übersicht: wie viele Nachrichten, wie viele eindeutig. */
export function overview(groups, totalMessages) {
  const inGroups = (groups || []).reduce((n, g) => n + g.messages.length, 0);
  const removable = (groups || []).reduce((n, g) => n + g.messages.length - 1, 0);
  const singles = Math.max(0, Number(totalMessages || 0) - inGroups);
  return {
    total: Number(totalMessages || 0),
    groups: (groups || []).length,
    inGroups,
    // „eindeutig" = Einzelstücke plus je eine Kopie aus jeder Gruppe
    unique: singles + (groups || []).length,
    singles,
    removable,
  };
}

/** Gruppiert die Vormerkungen für die Abschluss-Ansicht. */
export function groupByMark(review) {
  const out = { merge: [], delete: [], later: [], none: [] };
  for (const g of review.groups) out[markOf(review, g.key)].push(g);
  return out;
}

/** Kurzfassung für die Kopfzeile. */
export function markCounts(review) {
  const by = groupByMark(review);
  return {
    merge: by.merge.length,
    delete: by.delete.length,
    later: by.later.length,
    none: by.none.length,
    decided: by.merge.length + by.delete.length + by.later.length,
    total: review.groups.length,
  };
}

/**
 * Was eine Vormerkung beim Ausführen bedeutet — als Klartext, damit die
 * Rückfrage vor dem Ausführen nichts verschweigt.
 */
export function describePlan(review) {
  const by = groupByMark(review);
  const lines = [];
  if (by.merge.length) {
    const copies = by.merge.reduce((n, g) => n + g.messages.length, 0);
    lines.push(
      `${by.merge.length} Gruppe(n) zusammenfassen: aus ${copies} Kopien werden ` +
        `${by.merge.length} neue Nachricht(en).`
    );
  }
  if (by.delete.length) {
    const copies = by.delete.reduce((n, g) => n + g.messages.length - 1, 0);
    lines.push(`${by.delete.length} Gruppe(n) bereinigen: ${copies} Kopie(n) in den Papierkorb.`);
  }
  if (by.later.length) lines.push(`${by.later.length} Gruppe(n) bleiben für später vorgemerkt.`);
  if (by.none.length) lines.push(`${by.none.length} Gruppe(n) ohne Vormerkung bleiben unberührt.`);
  return lines;
}

/** Speicherform (klein genug für storage.local). */
export function serialize(review) {
  return { marks: review.marks };
}
