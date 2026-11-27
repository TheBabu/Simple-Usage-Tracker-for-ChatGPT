import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadTracker } from './helpers/tracker.mjs';

const source = readFileSync(new URL('../shared/usage.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const raw = { rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 18000 } } };
const json = (data, options) => Response.json(data, options);

function setup(fetch) {
  let now = Date.parse('2026-11-20T12:00:00Z');
  const storage = {};
  let receive;
  const ctx = vm.createContext({
    fetch, AbortSignal, atob,
    Date: class extends Date {
      static now() { return now; }
    },
    importScripts() {},
    chrome: {
      storage: { local: { get: async () => ({ ...storage }), set: async (updates) => Object.assign(storage, updates) } },
      runtime: {
        onMessage: { addListener: (fn) => { receive = fn; } },
        onInstalled: { addListener() {} },
      },
      tabs: { query: async () => [] },
      windows: { onCreated: { addListener() {} } },
    },
  });
  vm.runInContext(source, ctx);
  vm.runInContext(worker, ctx);
  const sendMessage = (message) => new Promise((resolve) => receive(message, {}, resolve));
  return {
    ctx,
    storage,
    now: () => now,
    advance: (ms) => { now += ms; },
    sendMessage,
    refresh: () => sendMessage({ type: 'cgut:refresh' }),
  };
}

test('repeated rate limits back off up to five minutes, preserve cached usage, and recover after sustained success', async () => {
  let calls = 0;
  let status = 200;
  const { storage, now, advance, refresh } = setup(async (url) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test' });
    calls++;
    return json({ ...raw, rate_limit_reset_credits: { available_count: 0 } }, { status });
  });
  assert.equal((await refresh()).ok, true);
  advance(10000);
  status = 429;
  for (const interval of [30000, 60000, 120000, 300000, 300000]) {
    assert.equal((await refresh()).ok, false);
    assert.equal(storage.usage.session.pct, 37);
    assert.equal(storage.usageBackoff.interval, interval);
    assert.equal(storage.usageBackoff.retryAt, now() + interval);
    const before = calls;
    advance(interval - 1);
    assert.equal((await refresh()).ok, false);
    assert.equal(calls, before);
    advance(1);
  }
  status = 200;
  assert.equal((await refresh()).ok, true);
  assert.equal(storage.usageBackoff.recoveryStartedAt, now());
  assert.equal(storage.usageBackoff.retryAt, now() + 300000);
  advance(10000);
  assert.equal((await refresh()).ok, false);
  assert.equal(calls, 7);
  advance(290000);
  assert.equal((await refresh()).ok, true);
  assert.equal(storage.usageBackoff, null);
  assert.equal(calls, 8);
  advance(10000);
  assert.equal((await refresh()).ok, true);
  assert.equal(calls, 9);
  assert.equal(storage.debugLog.at(-1).count, 2);
  assert.ok(storage.debugLog.some((entry) => entry.message.includes('Polling recovered')));
  assert.ok(storage.debugLog.some((entry) => entry.message.includes('Retry succeeded')));
  assert.ok(storage.debugLog.some((entry) => entry.level === 'warning' && entry.message.includes('backed off to 5m')));
});

test('recovery starts again on failure and consecutive successes do not shorten a cooldown', async () => {
  let status = 429;
  const { storage, now, advance, refresh } = setup(async (url) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test' });
    return json({ ...raw, rate_limit_reset_credits: { available_count: 0 } }, { status });
  });
  await refresh();
  advance(30000);
  status = 200;
  await refresh();
  advance(30000);
  await refresh();
  assert.equal(storage.usageBackoff.interval, 30000);
  assert.equal(storage.usageBackoff.recoveryStartedAt, now() - 30000);
  advance(30000);
  status = 429;
  await refresh();
  assert.equal(storage.usageBackoff.interval, 60000);
  assert.equal(storage.usageBackoff.recoveryStartedAt, null);
  advance(60000);
  status = 200;
  await refresh();
  advance(60000);
  status = 503;
  await refresh();
  assert.equal(storage.usageBackoff.interval, 60000);
  assert.equal(storage.usageBackoff.recoveryStartedAt, null);
  assert.equal(storage.usageBackoff.retryAt, now() + 60000);
  advance(60000);
  status = 200;
  await refresh();
  const started = now();
  for (let i = 0; i < 4; i++) {
    advance(60000);
    await refresh();
    assert.equal(storage.usageBackoff.recoveryStartedAt, started);
  }
  advance(60000);
  await refresh();
  assert.equal(storage.usageBackoff, null);
});

test('overlapping rate limits do not escalate and old stored cooldowns still work', () => {
  const { ctx, now } = setup(() => {});
  const error = { status: 429, at: now(), retryAt: now() + 600000 };
  const backoff = ctx.CGUT.nextUsageBackoff(null, error);
  assert.equal(backoff.interval, 30000);
  assert.equal(backoff.retryAt, now() + 600000);
  assert.equal(backoff.serverRetryAt, backoff.retryAt);
  const overlap = ctx.CGUT.nextUsageBackoff(backoff, { status: 429, at: now() + 1000 });
  assert.equal(overlap.interval, 30000);
  assert.equal(overlap.retryAt, backoff.retryAt);
  assert.equal(ctx.CGUT.nextUsageBackoff(overlap, null, now() + 2000), overlap);
  // A response that started before the retry was eligible cannot establish recovery.
  assert.equal(ctx.CGUT.nextUsageBackoff(overlap, null, overlap.retryAt + 1, now()), overlap);
  const legacy = { at: now(), retryAt: now() + 60000, interval: 60000 };
  const recovered = ctx.CGUT.nextUsageBackoff(legacy, null, legacy.retryAt);
  assert.equal(recovered.recoveryStartedAt, legacy.retryAt);
  assert.equal(recovered.retryAt, now() + 120000);
});

test('honors Retry-After from usage and reset details, with a valid usage result when only resets were limited', async () => {
  let status = 429;
  const { storage, now, advance, refresh } = setup(async (url) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test' });
    if (url.endsWith('/usage')) return json(raw, { status, headers: { 'Retry-After': '90' } });
    return json({}, { status: 429, headers: { 'Retry-After': new Date(now() + 120000).toUTCString() } });
  });
  assert.equal((await refresh()).ok, false);
  assert.equal(storage.usageBackoff.retryAt, now() + 90000);
  advance(90000);
  status = 200;
  assert.equal((await refresh()).ok, true);
  assert.equal(storage.usage.session.pct, 37);
  assert.equal(storage.usageBackoff.retryAt, now() + 120000);
  assert.equal(storage.usageBackoff.serverRetryAt, now() + 120000);
  assert.match(storage.debugLog.find((entry) => entry.message.includes('reset details')).message, /usage still updated/);
});

test('visible tabs start at 10 seconds, share fresh usage, and honor the cooldown', async () => {
  let calls = 0;
  let status = 200;
  const { ctx, storage, now, advance, sendMessage } = setup(async (url) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test' });
    calls++;
    return json({ ...raw, rate_limit_reset_credits: { available_count: 0 } }, { status });
  });
  const scheduled = [];
  ctx.document = {
    documentElement: { dataset: {} }, hidden: false,
    createElement: () => ({
      append() {}, replaceChildren() {}, addEventListener() {}, setAttribute() {}, classList: { add() {} },
    }),
  };
  ctx.location = { origin: 'https://chatgpt.com' };
  ctx.navigator = { locks: { request: async (_name, _options, callback) => callback({}) } };
  ctx.setTimeout = (_callback, delay) => scheduled.push(delay);
  ctx.clearTimeout = () => {};
  ctx.chrome.runtime.id = 'test';
  const ui = readFileSync(new URL('../shared/ui.js', import.meta.url), 'utf8');
  vm.runInContext(ui, ctx, { filename: 'shared/ui.js' });
  const tab = loadTracker(ctx, ['state', 'refresh']);
  ctx.chrome.runtime.sendMessage = async (message) => {
    await sendMessage(message);
    tab.state.usage = storage.usage;
    tab.state.error = storage.usageError;
    tab.state.backoff = storage.usageBackoff;
  };

  assert.equal((await tab.refresh()).ok, true);
  assert.equal(calls, 1);
  assert.equal(scheduled.at(-1), 10000);
  assert.equal((await tab.refresh()).skipped, true);
  assert.equal(calls, 1);

  advance(10000);
  status = 503;
  assert.equal((await tab.refresh()).ok, false);
  assert.equal(calls, 2);
  assert.equal(scheduled.at(-1), 10000);

  const error = { status: 429, at: now(), retryAt: now() + 90000 };
  storage.usageBackoff = ctx.CGUT.nextUsageBackoff(null, error);
  tab.state.backoff = storage.usageBackoff;
  advance(10000);
  assert.equal((await tab.refresh({ force: true })).ok, false);
  assert.equal(calls, 2);
  assert.equal(scheduled.at(-1), 80000);

  advance(80000);
  status = 200;
  assert.equal((await tab.refresh()).ok, true);
  assert.equal(calls, 3);
  assert.equal(scheduled.at(-1), 30000);
  advance(10000);
  assert.equal((await tab.refresh({ force: true })).ok, false);
  assert.equal(calls, 3);
  assert.equal(scheduled.at(-1), 20000);
  for (let i = 0; i < 10; i++) {
    advance(i === 0 ? 20000 : 30000);
    assert.equal((await tab.refresh()).ok, true);
  }
  assert.equal(storage.usageBackoff, null);
  assert.equal(scheduled.at(-1), 10000);
});

test('debug panel displays the shared countdown and recovery, and copies them with the log', async () => {
  const { ctx, storage, now, advance, sendMessage } = setup(() => { throw new Error('Unexpected fetch'); });
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const ids = Object.fromEntries(Array.from(html.matchAll(/id="([^"]+)"/g), ([, id]) => [id, {
    textContent: '', open: id === 'debug', append() {}, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { this[type] = fn; },
  }]));
  let onChange;
  let tick;
  let copied;
  ctx.document = {
    getElementById: (id) => ids[id],
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  ctx.navigator = { clipboard: { writeText: async (text) => { copied = text; } } };
  ctx.chrome.storage.onChanged = { addListener: (fn) => { onChange = fn; } };
  ctx.chrome.runtime.getManifest = () => ({ version: '1.2.3' });
  ctx.chrome.runtime.sendMessage = sendMessage;
  ctx.setInterval = (fn) => { tick = fn; };
  ctx.setTimeout = () => {};
  ctx.CGUT.ui = {
    UsagePanel: class { root = {}; resets = { before() {} }; render() {} },
    installTooltips() {},
  };
  storage.usage = ctx.CGUT.normalizeUsage(raw, now(), null, null);
  storage.usageBackoff = ctx.CGUT.nextUsageBackoff(null, { at: now(), status: 429, retryAt: now() + 90000 });
  storage.debugLog = [{ t: now(), firstAt: now() - 20000, level: 'success', message: 'Updated', count: 3 }];
  vm.runInContext(popup, ctx);
  await Promise.resolve();
  assert.equal(ids['poll-state'].textContent, 'Backed off');
  assert.match(ids['poll-next'].textContent, /1m 30s/);
  assert.match(ids['debug-log'].textContent, /3 times since/);
  advance(10000);
  tick();
  assert.match(ids['poll-next'].textContent, /1m 20s/);
  advance(80000);
  storage.usageBackoff = ctx.CGUT.nextUsageBackoff(storage.usageBackoff, null, now());
  onChange({ usageBackoff: { newValue: storage.usageBackoff } }, 'local');
  assert.equal(ids['poll-state'].textContent, 'Recovering');
  assert.match(ids['poll-recovery'].textContent, /10s after 5m/);
  await ids['copy-debug'].click();
  assert.match(copied, /state: Recovering/);
  assert.match(copied, /3 times since/);
  await ids['clear-log'].click();
  assert.equal(storage.debugLog.length, 0);
});
