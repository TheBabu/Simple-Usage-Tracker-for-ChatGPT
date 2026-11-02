// The toolbar popup: the same usage rows as the sidebar, a refresh button, options, and a debug
// panel.
'use strict';

(() => {
  const CGUT = globalThis.CGUT;
  const { ui } = CGUT;
  const $ = (id) => document.getElementById(id);

  const STALE_ON_OPEN_MS = 60 * 1000;
  const KEYS = ['usage', 'usageError', 'creditLedger', 'debugLog', 'usageDisplay'];

  const panel = new ui.UsagePanel();
  $('panel').append(panel.root);
  panel.resets.before(document.querySelector('.popup-footer'));
  const displayInputs = document.querySelectorAll('input[name="usage-display"]');
  ui.installTooltips();

  let stored = {};

  function render() {
    const now = Date.now();
    const usage = stored.usage || null;
    const display = stored.usageDisplay === 'left' ? 'left' : 'used';
    panel.render({ usage, error: stored.usageError || null, ledger: stored.creditLedger || {}, display }, now);
    for (const input of displayInputs) input.checked = input.value === display;

    const plan = CGUT.planLabel(usage?.planType);
    $('plan').hidden = !plan;
    $('plan').textContent = plan || '';
    $('updated').textContent = usage ? `Updated ${CGUT.formatAgo(usage.fetchedAt, now)}` : '';

    if ($('debug').open) renderDebug();
  }

  function windowForDebug(win) {
    return win && { pct: win.pct, windowSec: win.windowSec, resetsAt: win.resetsAt && new Date(win.resetsAt).toLocaleString() };
  }

  function debugStatus() {
    const usage = stored.usage;
    const error = stored.usageError;
    return {
      version: chrome.runtime.getManifest().version,
      account: usage ? `${usage.accountId.slice(0, 8)}…` : null,
      plan: usage?.planType ?? null,
      fetchedAt: usage ? new Date(usage.fetchedAt).toLocaleString() : null,
      session: windowForDebug(usage?.session),
      weekly: windowForDebug(usage?.weekly),
      limitReached: usage?.limitReached ?? null,
      credits: usage?.credits ?? null,
      creditLedger: usage ? stored.creditLedger?.[usage.accountId] ?? null : null,
      lastError: error ? `${error.message} (${new Date(error.at).toLocaleString()})` : null,
    };
  }

  function debugLogText() {
    const lines = (stored.debugLog || []).slice().reverse()
      .map((entry) => `${new Date(entry.t).toLocaleTimeString()}  ${entry.message}`);
    return lines.join('\n') || '(empty)';
  }

  function renderDebug() {
    $('debug-status').textContent = JSON.stringify(debugStatus(), null, 2);
    $('debug-log').textContent = debugLogText();
    $('debug-raw').textContent = stored.usage?.raw ? JSON.stringify(stored.usage.raw, null, 2) : '(none yet)';
  }

  async function refresh() {
    const button = $('refresh');
    button.disabled = true;
    button.classList.add('spinning');
    try {
      await chrome.runtime.sendMessage({ type: 'cgut:refresh' });
    } finally {
      button.disabled = false;
      button.classList.remove('spinning');
    }
  }

  async function copyDebug() {
    const text = [
      JSON.stringify(debugStatus(), null, 2),
      debugLogText(),
      stored.usage?.raw ? JSON.stringify(stored.usage.raw, null, 2) : '',
    ].join('\n\n');
    await navigator.clipboard.writeText(text);
    $('copy-debug').textContent = 'Copied';
    setTimeout(() => { $('copy-debug').textContent = 'Copy'; }, 1500);
  }

  // The percentages can say how much is used (as ChatGPT reports it) or how much is left. The
  // popup, the sidebar and the bar in the message box all follow, the open tabs through storage.
  for (const input of displayInputs) {
    input.addEventListener('change', () => chrome.storage.local.set({ usageDisplay: input.value }));
  }

  // The composer bar and ChatGPT's own low-usage popup can be controlled independently. The native
  // popup is hidden by default; open chatgpt.com tabs pick changes up from storage.
  const showBar = $('show-bar');
  const hideUsagePopup = $('hide-usage-popup');
  chrome.storage.local.get(['showComposerBar', 'hideUsagePopup']).then((options) => {
    showBar.checked = options.showComposerBar !== false;
    hideUsagePopup.checked = options.hideUsagePopup !== false;
  });
  showBar.addEventListener('change', () => chrome.storage.local.set({ showComposerBar: showBar.checked }));
  hideUsagePopup.addEventListener('change', () => chrome.storage.local.set({ hideUsagePopup: hideUsagePopup.checked }));

  // Opens the Release Notes page in a tab (a plain link would open it inside the popup).
  $('release-notes').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('release-notes/release-notes.html') });
    window.close();
  });

  $('refresh').addEventListener('click', refresh);
  $('copy-debug').addEventListener('click', copyDebug);
  $('clear-log').addEventListener('click', () => chrome.storage.local.set({ debugLog: [] }));
  $('debug').addEventListener('toggle', render);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of KEYS) {
      if (changes[key]) stored[key] = changes[key].newValue;
    }
    render();
  });

  chrome.storage.local.get(KEYS).then((values) => {
    stored = values;
    render();
    setInterval(render, 1000);
    if (!stored.usage || Date.now() - stored.usage.fetchedAt > STALE_ON_OPEN_MS) refresh();
  });
})();
