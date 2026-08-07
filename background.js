// background.js — hält nur den Einstieg und merkt sich die zuletzt gewählten
// Nachrichten, damit das Werkzeug-Tab sie beim Öffnen findet.

const TOOL_URL = "ui/tool.html";
let pending = { ids: [], source: "none" };

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

async function selectionFromMailTab() {
  try {
    const [mailTab] = await browser.mailTabs.query({ active: true, currentWindow: true });
    if (!mailTab) return [];
    const page = await browser.mailTabs.getSelectedMessages(mailTab.id);
    return page.messages.map((m) => m.id);
  } catch {
    return [];
  }
}

browser.browserAction.onClicked.addListener(async () => {
  pending = { ids: await selectionFromMailTab(), source: "selection" };
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
  pending = { ids, source: "display" };
  await openTool();
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "getPending") return Promise.resolve(pending);
  if (msg?.type === "getSelection") return selectionFromMailTab().then((ids) => ({ ids }));
  return undefined;
});
