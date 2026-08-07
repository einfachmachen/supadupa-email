// fakeMessenger.js — Attrappe der Thunderbird-API für Tests.
//
// Damit lässt sich der ECHTE Weg testen (loadForLightTable → Anhänge,
// Inline-Bilder, Lesedokument) statt nur die Einzelteile. Genau dort steckten
// bisher die Fehler: Die Bausteine waren in Ordnung, ihr Zusammenspiel nicht.

import { listParts, extractPart, decodeBody } from "../../lib/mimeparts.js";
import { splitMessage, getHeader } from "../../lib/rawmail.js";

function charsetOf(contentTypeRaw) {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentTypeRaw || "");
  return (m ? m[1] : "utf-8").toLowerCase();
}

/** Baut aus Roh-Bytes den Baum, den `messages.getFull()` liefern würde. */
function buildFull(bytes) {
  const parts = listParts(bytes);
  const nodes = parts.map((p) => {
    const node = {
      contentType: p.contentType,
      partName: String(p.index),
      headers: {},
      parts: [],
    };
    if (p.contentType.startsWith("text/")) {
      const data = decodeBody(extractPart(bytes, p));
      try {
        node.body = new TextDecoder(charsetOf(p.contentTypeRaw)).decode(data);
      } catch {
        node.body = new TextDecoder("utf-8").decode(data);
      }
    }
    if (p.filename) node.name = p.filename;
    return node;
  });
  // Verschachtelung über die Tiefe wiederherstellen
  const root = nodes[0];
  const stack = [{ depth: parts[0].depth, node: root }];
  for (let i = 1; i < parts.length; i++) {
    while (stack.length && stack[stack.length - 1].depth >= parts[i].depth) stack.pop();
    (stack[stack.length - 1]?.node || root).parts.push(nodes[i]);
    stack.push({ depth: parts[i].depth, node: nodes[i] });
  }
  return root;
}

/**
 * Erzeugt eine Attrappe von `messenger` für eine oder mehrere Nachrichten.
 * @param {Array<{id:number, bytes:Uint8Array, folder?:object}>} messages
 */
export function fakeMessenger(messages) {
  const store = new Map(messages.map((m) => [m.id, m]));
  const imported = [];

  const headerOf = (m) => {
    const h = splitMessage(m.bytes).headerText;
    return {
      id: m.id,
      subject: getHeader(h, "Subject"),
      author: getHeader(h, "From"),
      recipients: getHeader(h, "To") ? [getHeader(h, "To")] : [],
      ccList: getHeader(h, "Cc") ? [getHeader(h, "Cc")] : [],
      date: new Date(getHeader(h, "Date") || Date.now()),
      headerMessageId: getHeader(h, "Message-ID").replace(/^<|>$/g, ""),
      size: m.bytes.length,
      read: true,
      flagged: false,
      tags: [],
      folder: m.folder || { path: "/Testordner", accountId: "acc1" },
    };
  };

  return {
    imported,
    messages: {
      async get(id) {
        return headerOf(store.get(id));
      },
      async getFull(id) {
        return buildFull(store.get(id).bytes);
      },
      async getRaw(id, opts) {
        const bytes = store.get(id).bytes;
        if (opts?.data_format === "File") {
          return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        }
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        return s;
      },
      async listAttachments(id) {
        // Thunderbird liefert hier NUR das, was es selbst für Anhänge hält —
        // bewusst absichtlich abweichend, damit die Erweiterung sich nicht
        // darauf verlässt.
        return listParts(store.get(id).bytes)
          .filter((p) => p.filename && !p.contentType.startsWith("multipart/"))
          .map((p, i) => ({
            name: p.filename,
            contentType: p.contentType,
            size: decodeBody(extractPart(store.get(id).bytes, p)).length,
            partName: `1.${i + 2}`,
          }));
      },
      async import(file, folder, props) {
        const id = 1000 + imported.length;
        imported.push({ id, file, folder, props });
        return { id };
      },
      async delete() {},
      async list() {
        return { messages: messages.map(headerOf) };
      },
    },
    folders: { async get(id) { return { path: id }; } },
    accounts: { async list() { return [{ id: "acc1", name: "Test", folders: [] }]; } },
    addressBooks: { async list() { return []; } },
    storage: { local: { async get() { return {}; }, async set() {} } },
    runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } },
  };
}

/** Setzt die Attrappe als globales `messenger` und gibt eine Aufräumfunktion zurück. */
export function withFakeMessenger(messages) {
  const api = fakeMessenger(messages);
  globalThis.messenger = api;
  globalThis.browser = api;
  return {
    api,
    restore() {
      delete globalThis.messenger;
      delete globalThis.browser;
    },
  };
}
