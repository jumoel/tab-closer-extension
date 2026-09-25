import { compileRules, matchingLines } from './rules.js';

const generations = new Map();
let nextGeneration = 0;

function invalidate(tabId) {
  generations.set(tabId, ++nextGeneration);
  return generations.get(tabId);
}

function current(tabId, generation) {
  return generations.get(tabId) === generation;
}

function report(operation, error) {
  const line = Number.isInteger(error?.line) ? `, rule line ${error.line}` : '';
  console.error(`Tab Closer: ${operation} failed${line}.`);
}

async function readRecord() {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings === undefined) return { version: 1, revision: null, rules: '' };
  if (settings?.version !== 1 || typeof settings.revision !== 'string' || typeof settings.rules !== 'string') {
    throw new Error('Invalid settings record');
  }
  return settings;
}

async function closeCompleted(details) {
  if (details.frameId !== 0 || details.documentLifecycle !== 'active' || !details.documentId || typeof details.url !== 'string') return;
  const { tabId, documentId, url } = details;
  const generation = invalidate(tabId);
  let record;
  try {
    record = await readRecord();
    if (!current(tabId, generation) || !record.rules.trim()) return;
    const matches = matchingLines(compileRules(record.rules), url, true);
    if (!matches.length || !current(tabId, generation)) return;
  } catch (error) {
    report('reading or evaluating rules', error);
    return;
  }
  try {
    const latest = await readRecord();
    if (!current(tabId, generation) || latest.revision !== record.revision) return;
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!current(tabId, generation) || frame?.documentId !== documentId || frame.url !== url || frame.documentLifecycle !== 'active') return;
    const tab = await chrome.tabs.get(tabId);
    if (!current(tabId, generation) || tab.url !== url || tab.pendingUrl) return;
    if (!current(tabId, generation)) return;
    await chrome.tabs.remove(tabId);
  } catch (error) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return; // The tab disappeared during the attempt.
    }
    report('checking tab state or removing tab', error);
  }
}

chrome.webNavigation.onCompleted.addListener(details => { void closeCompleted(details); });
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId === 0) invalidate(details.tabId);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId === 0) invalidate(details.tabId);
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => {
  if (details.frameId === 0) invalidate(details.tabId);
});
chrome.tabs.onRemoved.addListener(tabId => { generations.delete(tabId); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    for (const tabId of generations.keys()) invalidate(tabId);
  }
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage().catch(error => report('opening settings', error)); });
