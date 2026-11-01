// Owns the shared state in chrome.storage.local: the latest usage, the last error, the per-account
// monthly credit tally and a short debug log. Tabs do the fetching; this worker stores what they
// report, and fetches itself only when the popup asks and no chatgpt.com tab can. After an update
// it also opens the Release Notes page.
'use strict';

importScripts('shared/usage.js', 'release-notes/versions.js');

const LOG_LIMIT = 150;
const LEDGER_MONTHS_KEPT = 12;

// Every read-modify-write of storage goes through this queue. Without it two tabs reporting at
// once would both read the same previous balance and count the same spend twice.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function appendLog(message) {
  const { debugLog = [] } = await chrome.storage.local.get('debugLog');
  debugLog.push({ t: Date.now(), message: String(message).slice(0, 500) });
  await chrome.storage.local.set({ debugLog: debugLog.slice(-LOG_LIMIT) });
}

function log(message) {
  return serialized(() => appendLog(message));
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

function describeUsage(usage, spent) {
  const parts = [];
  if (usage.session) parts.push(`${CGUT.windowLabel(usage.session, '5-hour')} ${CGUT.formatPct(usage.session.pct)}`);
  if (usage.weekly) parts.push(`${CGUT.windowLabel(usage.weekly, 'weekly')} ${CGUT.formatPct(usage.weekly.pct)}`);
  if (usage.credits?.balance != null) parts.push(`credits ${CGUT.formatCredits(usage.credits.balance)}`);
  if (spent > 0) parts.push(`spent ${CGUT.formatCredits(spent)}`);
  return `Updated: ${parts.join(', ') || 'no limits reported'}`;
}

// ChatGPT reports a credit balance, not what was spent, so the monthly figure is built from drops
// in the balance between fetches. Rises (top-ups, grants) are not usage. Neither is a drop while
// every limit had room: credits are only drawn past a limit, so that drop is credits expiring.
function recordBalance(ledger, usage) {
  const entry = ledger[usage.accountId] || { lastBalance: null, lastOverLimit: false, months: {} };
  const balance = usage.credits?.balance ?? null;
  const overLimit = CGUT.isOverLimit(usage);
  let spent = 0;

  if (balance !== null && entry.lastBalance !== null && balance < entry.lastBalance && (overLimit || entry.lastOverLimit)) {
    spent = round(entry.lastBalance - balance);
    const month = CGUT.monthKey(new Date(usage.fetchedAt));
    entry.months[month] = round((entry.months[month] || 0) + spent);
    const keep = Object.keys(entry.months).sort().slice(-LEDGER_MONTHS_KEPT);
    entry.months = Object.fromEntries(keep.map((key) => [key, entry.months[key]]));
  }
  if (balance !== null) entry.lastBalance = balance;
  entry.lastOverLimit = overLimit;

  ledger[usage.accountId] = entry;
  return spent;
}

async function storeUsage(fetched) {
  const usage = CGUT.normalizeUsage(fetched.raw, fetched.fetchedAt, fetched.accountId, fetched.resetCredits);
  const { usage: previous, creditLedger = {} } = await chrome.storage.local.get(['usage', 'creditLedger']);

  // Tabs can finish fetches out of order; an older answer must not replace a newer one.
  if (previous && previous.accountId === usage.accountId && previous.fetchedAt >= usage.fetchedAt) return;

  const spent = recordBalance(creditLedger, usage);
  await chrome.storage.local.set({ usage, usageError: null, creditLedger });
  await appendLog(describeUsage(usage, spent));
}

async function storeError(error) {
  await chrome.storage.local.set({ usageError: error });
  await appendLog(`Update failed: ${error.message}`);
}

// Prefers an open chatgpt.com tab, which fetches exactly as the page itself would. With none
// open, the worker tries directly with the browser's chatgpt.com cookies.
async function refreshNow() {
  const tabs = await chrome.tabs.query({ url: `${CGUT.ORIGIN}/*` });
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));

  for (const tab of tabs) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'cgut:refresh' });
      if (result) return { ...result, via: 'tab' };
    } catch {
      // No content script there (the tab predates the install, or was discarded).
    }
  }

  try {
    const fetched = await CGUT.fetchUsage();
    await serialized(() => storeUsage(fetched));
    return { ok: true, via: 'background' };
  } catch (e) {
    const error = CGUT.errorRecord(e);
    await serialized(() => storeError(error));
    return { ok: false, error: error.message, via: 'background' };
  }
}

async function useReset(message) {
  let shouldRefresh = false;
  const result = await serialized(async () => {
    const { usage } = await chrome.storage.local.get('usage');
    const reset = usage?.accountId === message.accountId && usage.manualResets?.find((r) => r.id === message.creditId);
    if (!reset || (reset.expiresAt !== null && reset.expiresAt <= Date.now())) {
      return { ok: false, error: 'This Reset is no longer available. Refresh usage and try again.' };
    }
    shouldRefresh = true;
    try {
      await CGUT.consumeReset(message);
      // Remove it before refreshing so other tabs cannot submit the same reset in the meantime.
      await chrome.storage.local.set({ usage: { ...usage, manualResets: usage.manualResets.filter((r) => r.id !== reset.id) } });
      await appendLog('Used a manual usage Reset');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'Could not confirm the Reset. Refresh usage before trying again.', reuseRequestId: e.code !== 'reset-rejected' };
    }
  });
  if (!shouldRefresh) return result;
  // Fetch this account directly: a tab may still have a pre-reset request in flight or skip a
  // forced refresh because it polled recently.
  try {
    const fetched = await CGUT.fetchUsage({ accountHint: message.accountId });
    await serialized(() => storeUsage(fetched));
  } catch (e) {
    await serialized(() => storeError(CGUT.errorRecord(e)));
  }
  return result;
}

const handlers = {
  'cgut:store': (message) => serialized(() => storeUsage(message.fetched)),
  'cgut:error': (message) => serialized(() => storeError(message.error)),
  'cgut:log': (message) => log(message.message),
  'cgut:refresh': () => refreshNow(),
  'cgut:use-reset': (message) => useReset(message),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(
    (result) => sendResponse(result ?? { ok: true }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});

// After an update that has release notes, opens them in a tab behind the current one, so it is
// there to read without interrupting a chat. Reloading the same version (as in development), an
// update without notes, and turning the page off on the page itself all open nothing.
async function showReleaseNotes(previousVersion) {
  const version = chrome.runtime.getManifest().version;
  if (!previousVersion || CGUT.compareVersions(version, previousVersion) <= 0) return;
  const changelog = await (await fetch(chrome.runtime.getURL('release-notes/changelog.json'))).json();
  if (!CGUT.changelogSince(changelog, previousVersion, version).length) return;
  const { releaseNotesOnUpdate } = await chrome.storage.local.get('releaseNotesOnUpdate');
  if (releaseNotesOnUpdate === false) return;
  await openReleaseNotes(previousVersion);
}

// Chrome can install an update while no window is open (running in the background, or a Mac with
// every window closed). There is nowhere to put the tab then, so it opens in the next window.
async function openReleaseNotes(previousVersion, windowId) {
  const url = chrome.runtime.getURL(`release-notes/release-notes.html?from=${encodeURIComponent(previousVersion)}`);
  try {
    await chrome.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) });
  } catch (e) {
    await chrome.storage.local.set({ releaseNotesPending: previousVersion });
    log(`Release Notes will open in the next window (${e.message})`);
  }
}

chrome.windows.onCreated.addListener(async ({ id }) => {
  const { releaseNotesPending } = await chrome.storage.local.get('releaseNotesPending');
  if (!releaseNotesPending) return;
  await chrome.storage.local.remove('releaseNotesPending');
  openReleaseNotes(releaseNotesPending, id);
}, { windowTypes: ['normal'] });

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  log(`Extension ${reason} (v${chrome.runtime.getManifest().version})`);
  if (reason === 'update') showReleaseNotes(previousVersion);
});
