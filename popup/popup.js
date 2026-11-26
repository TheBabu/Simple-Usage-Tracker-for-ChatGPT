// The toolbar popup: the same usage rows as the sidebar, a refresh button, options, and a debug
// panel.
'use strict';

(() => {
  const CGUT = globalThis.CGUT;
  const { ui } = CGUT;
  const $ = (id) => document.getElementById(id);

  const STALE_ON_OPEN_MS = 60 * 1000;
  const KEYS = ['usage', 'usageError', 'usageBackoff', 'creditLedger', 'debugLog', 'usageDisplay'];

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
    $('refresh').title = stored.usageBackoff ? CGUT.backoffMessage(stored.usageBackoff, now) : 'Refresh';

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

  function dateTime(at) {
    return at ? new Date(at).toLocaleString() : '—';
  }

  function pollingStatus(now = Date.now()) {
    const backoff = stored.usageBackoff;
    const error = stored.usageError;
    const recovering = backoff?.recoveryStartedAt != null;
    const wait = backoff ? backoff.retryAt - now : 0;
    const recoveryWait = recovering ? backoff.recoveryStartedAt + CGUT.USAGE_RECOVERY_MS - now : 0;
    return {
      state: backoff ? recovering ? 'Recovering' : 'Backed off'
        : error?.code === 'signed-out' ? 'Signed out' : error ? 'Update failed' : stored.usage ? 'Normal' : 'Waiting for first update',
      interval: backoff ? CGUT.formatPollDelay(backoff.interval) : error?.code === 'signed-out' ? '60s (visible)' : '10s (visible)',
      updated: stored.usage ? `${dateTime(stored.usage.fetchedAt)} (${CGUT.formatAgo(stored.usage.fetchedAt, now)})` : 'Never',
      next: backoff ? wait > 0 ? `${CGUT.formatPollDelay(wait)} · ${dateTime(backoff.retryAt)}` : 'Ready on next poll' : 'Normal schedule',
      limited: dateTime(backoff?.at),
      server: dateTime(backoff?.serverRetryAt ?? (error?.status === 429 ? error.retryAt : null)),
      recovery: backoff ? recovering ? recoveryWait > 0
        ? `10s after ${CGUT.formatPollDelay(recoveryWait)} and a successful retry` : '10s after next successful retry'
        : 'Waiting for a successful retry' : '—',
      error: error ? error.message : 'None',
    };
  }

  function debugLogText() {
    const levels = { info: 'INFO', success: 'OK', warning: 'WARN', error: 'ERROR' };
    const lines = (stored.debugLog || []).slice().reverse()
      .map((entry) => {
        const time = dateTime(entry.t);
        const first = entry.count > 1 ? ` · ${entry.count} times since ${dateTime(entry.firstAt)}` : '';
        return `${time}  [${levels[entry.level] || 'INFO'}]${first}\n${entry.message}`;
      });
    return lines.join('\n\n') || '(empty)';
  }

  function setText(id, value) {
    const element = $(id);
    if (element.textContent !== value) element.textContent = value;
  }

  function renderDebug() {
    for (const [key, value] of Object.entries(pollingStatus())) setText(`poll-${key}`, value);
    setText('debug-status', JSON.stringify(debugStatus(), null, 2));
    setText('debug-log', debugLogText());
    setText('debug-raw', stored.usage?.raw ? JSON.stringify(stored.usage.raw, null, 2) : '(none yet)');
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
      'ChatGPT Usage Tracker — polling status',
      Object.entries(pollingStatus()).map(([key, value]) => `${key}: ${value}`).join('\n'),
      'Usage details\n' + JSON.stringify(debugStatus(), null, 2),
      'Recent events (newest first)\n' + debugLogText(),
      'Last raw response\n' + (stored.usage?.raw ? JSON.stringify(stored.usage.raw, null, 2) : '(none yet)'),
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

  // The native usage-limit banner is hidden by default; open tabs follow storage changes.
  const showBar = $('show-bar');
  const hideUsageLimitBanner = $('hide-usage-limit-banner');
  chrome.storage.local.get(['showComposerBar', 'hideUsageLimitBanner']).then((options) => {
    showBar.checked = options.showComposerBar !== false;
    hideUsageLimitBanner.checked = options.hideUsageLimitBanner !== false;
  });
  showBar.addEventListener('change', () => chrome.storage.local.set({ showComposerBar: showBar.checked }));
  hideUsageLimitBanner.addEventListener('change', () => chrome.storage.local.set({ hideUsageLimitBanner: hideUsageLimitBanner.checked }));

  // Opens the Release Notes page in a tab (a plain link would open it inside the popup).
  $('release-notes').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('release-notes/release-notes.html') });
    window.close();
  });

  $('refresh').addEventListener('click', refresh);
  $('copy-debug').addEventListener('click', copyDebug);
  $('clear-log').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cgut:clear-log' }));
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
