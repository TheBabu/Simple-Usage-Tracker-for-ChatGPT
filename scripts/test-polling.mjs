import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../shared/usage.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const tracker = readFileSync(new URL('../content/tracker.js', import.meta.url), 'utf8');
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
  return {
    ctx,
    storage,
    now: () => now,
    advance: (ms) => { now += ms; },
    refresh: () => new Promise((resolve) => receive({ type: 'cgut:refresh' }, {}, resolve)),
  };
}

test('refresh backs off to 30 and 60 seconds, preserves cached usage, and recovers after successful updates', async () => {
  let remaining429s = 3;
  let calls = 0;
  const { storage, now, advance, refresh } = setup(async (url) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test' });
    calls++;
    if (calls === 1 || remaining429s-- <= 0) return json({ ...raw, rate_limit_reset_credits: { available_count: 0 } });
    return json({}, { status: 429 });
  });
  assert.equal((await refresh()).ok, true);
  advance(10000);
  assert.equal((await refresh()).ok, false);
  assert.equal(storage.usage.session.pct, 37);
  assert.equal(storage.usageBackoff.retryAt, now() + 30000);
  advance(29999);
  await refresh();
  assert.equal(calls, 2);
  advance(1);
  await refresh();
  assert.equal(storage.usageBackoff.retryAt, now() + 60000);
  advance(60000);
  await refresh();
  assert.equal(storage.usageBackoff.retryAt, now() + 60000);
  advance(60000);
  assert.equal((await refresh()).ok, true);
  assert.equal(storage.usageBackoff.interval, 60000);
  await refresh();
  assert.equal(calls, 5);
  advance(240000);
  assert.equal((await refresh()).ok, true);
  assert.equal(storage.usageBackoff, null);
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
});

test('visible tabs share fresh usage and forced refreshes still wait during a cooldown', async () => {
  let calls = 0;
  const { ctx, storage, now, advance, refresh } = setup(async (url) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test' });
    calls++;
    return json({ ...raw, rate_limit_reset_credits: { available_count: 0 } });
  });
  const scheduled = [];
  ctx.document = { documentElement: { dataset: {} }, hidden: false };
  ctx.location = { origin: 'https://chatgpt.com' };
  ctx.navigator = { locks: { request: async (_name, _options, callback) => callback({}) } };
  ctx.setTimeout = (_callback, delay) => scheduled.push(delay);
  ctx.clearTimeout = () => {};
  ctx.chrome.runtime.id = 'test';
  ctx.chrome.runtime.sendMessage = async () => {
    throw new Error('A fresh cache or a cooldown should prevent the fetch');
  };
  await refresh();
  const scheduling = tracker.split('  // ---------- Replies and credit spend ----------')[0];
  vm.runInContext(scheduling + '  CGUT.tab = { state, refresh };\n})();', ctx);
  const tab = ctx.CGUT.tab;
  tab.state.usage = storage.usage;
  assert.equal((await tab.refresh()).skipped, true);
  assert.equal(calls, 1);
  assert.equal(scheduled.at(-1), 10000);

  const error = { status: 429, at: now(), retryAt: now() + 90000 };
  storage.usageBackoff = ctx.CGUT.nextUsageBackoff(null, error);
  tab.state.backoff = storage.usageBackoff;
  advance(10000);
  assert.equal((await tab.refresh({ force: true })).ok, false);
  assert.equal(calls, 1);
  assert.equal(scheduled.at(-1), 80000);
});
