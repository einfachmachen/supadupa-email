// background.js — hält nur den Einstieg und merkt sich die zuletzt gewählten
// Nachrichten, damit das Werkzeug-Tab sie beim Öffnen findet.

const TOOL_URL = "ui/tool.html";
let pending = { ids: [], folder: null, source: "none" };

async function openTool() {
  const url = browser.runtime.getURL(TOOL_URL);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url === url);
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.runtime.sendMessage({ type: "refresh" }).catch(() => {});
    return existing;
  }
  return browser.tabs.create({ url });
}

/**
 * Was im Hauptfenster gerade dran ist: die markierten Nachrichten UND der
 * angezeigte Ordner. Der Ordner ist wichtig, weil die Erweiterung sonst nicht
 * weiß, worauf sich „dieser Ordner" bezieht — man musste ihn bisher von Hand
 * ein zweites Mal auswählen.
 */
async function contextFromMailTab() {
  try {
    const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
    if (!mailTab) return { ids: [], folder: null };
    let ids = [];
    try {
      const page = await browser.mailTabs.getSelectedMessages(mailTab.id);
      ids = (page.messages || []).map((m) => m.id);
    } catch {
      ids = [];
    }
    const folder = mailTab.displayedFolder || mailTab.folder || null;
    return { ids, folder };
  } catch {
    return { ids: [], folder: null };
  }
}

browser.browserAction.onClicked.addListener(async () => {
  const ctx = await contextFromMailTab();
  pending = { ...ctx, source: "selection" };
  await openTool();
});

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  let ids = [];
  try {
    const msgs = await browser.messageDisplay.getDisplayedMessages(tab.id);
    ids = (msgs.messages || msgs).map((m) => m.id);
  } catch {
    ids = [];
  }
  const ctx = await contextFromMailTab();
  pending = { ids, folder: ctx.folder, source: "display" };
  await openTool();
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "getPending") return Promise.resolve(pending);
  if (msg?.type === "getSelection") return contextFromMailTab();
  return undefined;
});
