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
    let state = stored.usage ? 'Normal' : 'Waiting for first update';
    let interval = '10s (visible)';
    let next = 'Normal schedule';
    let recovery = '—';
    if (backoff) {
      const wait = backoff.retryAt - now;
      interval = CGUT.formatPollDelay(backoff.interval);
      next = wait > 0 ? `${CGUT.formatPollDelay(wait)} · ${dateTime(backoff.retryAt)}` : 'Ready on next poll';
      if (backoff.recoveryStartedAt != null) {
        state = 'Recovering';
        const remaining = backoff.recoveryStartedAt + CGUT.USAGE_RECOVERY_MS - now;
        recovery = remaining > 0
          ? `10s after ${CGUT.formatPollDelay(remaining)} and a successful retry`
          : '10s after next successful retry';
      } else {
        state = 'Backed off';
        recovery = 'Waiting for a successful retry';
      }
    } else if (error?.code === 'signed-out') {
      state = 'Signed out';
      interval = '60s (visible)';
    } else if (error) {
      state = 'Update failed';
    }
    return {
      state,
      interval,
      updated: stored.usage ? `${dateTime(stored.usage.fetchedAt)} (${CGUT.formatAgo(stored.usage.fetchedAt, now)})` : 'Never',
      next,
      limited: dateTime(backoff?.at),
      server: dateTime(backoff?.serverRetryAt ?? (error?.status === 429 ? error.retryAt : null)),
      recovery,
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

  function debugReport() {
    return {
      polling: pollingStatus(),
      status: JSON.stringify(debugStatus(), null, 2),
      log: debugLogText(),
      raw: stored.usage?.raw ? JSON.stringify(stored.usage.raw, null, 2) : '(none yet)',
    };
  }

  function renderDebug() {
    const report = debugReport();
    for (const [key, value] of Object.entries(report.polling)) setText(`poll-${key}`, value);
    setText('debug-status', report.status);
    setText('debug-log', report.log);
    setText('debug-raw', report.raw);
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
    const report = debugReport();
    const text = [
      'ChatGPT Usage Tracker — polling status',
      Object.entries(report.polling).map(([key, value]) => `${key}: ${value}`).join('\n'),
      'Usage details\n' + report.status,
      'Recent events (newest first)\n' + report.log,
      'Last raw response\n' + report.raw,
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
