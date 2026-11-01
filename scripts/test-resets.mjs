import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('../shared/usage.js', import.meta.url), 'utf8');
const accountId = '12345678-1234-1234-1234-123456789abc';
const requestId = '12345678-1234-1234-1234-123456789def';
const future = '2099-01-01T00:00:00Z';
const credit = { id: 'reset-1', title: 'Weekly reset', status: 'available', expires_at: future };
const resetCredits = { available_count: 1, credits: [credit] };
const usage = { rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000 } } };

function context(fetch) {
  const ctx = vm.createContext({ fetch, AbortSignal, atob });
  vm.runInContext(source, ctx);
  return ctx;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const session = () => json({ accessToken: 'test-token', account: { id: accountId } });

test('only available, unexpired, well-formed resets are shown, earliest expiration first', () => {
  const { CGUT } = context();
  const data = { credits: [
    { ...credit, id: 'no-expiry', expires_at: null }, credit,
    { ...credit, id: 'used', status: 'redeemed' },
    { ...credit, id: 'expired', expires_at: '2020-01-01' },
    { ...credit, id: 'invalid', expires_at: 'not-a-date' },
    { ...credit, id: '' }, null,
    { ...credit, id: 'seconds', expires_at: Date.parse(future) / 1000 + 1 },
    { ...credit, id: 'milliseconds', expires_at: Date.parse(future) + 2000 },
  ] };
  assert.deepEqual(Array.from(CGUT.availableResets(data), (r) => r.id), ['reset-1', 'seconds', 'milliseconds', 'no-expiry']);
  assert.equal(CGUT.availableResets({ ...data, available_count: 0 }).length, 0);
  assert.equal(CGUT.availableResets(null).length, 0);
  assert.equal(CGUT.normalizeUsage(usage, Date.now(), accountId, resetCredits).manualResets.length, 1);
});

test('fetches reset details with the usage account and keeps ordinary usage if resets fail', async () => {
  const calls = [];
  let failResets = false;
  const { CGUT } = context(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/session')) return session();
    if (url.endsWith('/usage')) return json(usage);
    return failResets ? json({}, 503) : json(resetCredits);
  });
  const fetched = await CGUT.fetchUsage();
  assert.equal(fetched.resetCredits.credits[0].id, credit.id);
  assert.equal(calls.at(-1).options.headers['ChatGPT-Account-Id'], accountId);
  failResets = true;
  const failed = await CGUT.fetchUsage();
  assert.equal(failed.raw.rate_limit.primary_window.used_percent, 90);
  assert.equal(failed.resetCredits, null);
});

test('zero available count skips the reset details request', async () => {
  const calls = [];
  const { CGUT } = context(async (url) => {
    calls.push(url);
    return url.endsWith('/api/auth/session') ? session() : json({ ...usage, rate_limit_reset_credits: { available_count: 0 } });
  });
  assert.equal((await CGUT.fetchUsage()).resetCredits, null);
  assert.equal(calls.length, 2);
});

test('consumes only the selected credit with an idempotency ID and checks the response code', async () => {
  let code = 'reset';
  const posts = [];
  const { CGUT } = context(async (url, options) => {
    if (url.endsWith('/api/auth/session')) return session();
    posts.push({ url, options });
    return json({ code });
  });
  const request = { accountId, creditId: credit.id, requestId };
  await CGUT.consumeReset(request);
  assert.equal(posts[0].url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  assert.equal(posts[0].options.method, 'POST');
  assert.equal(posts[0].options.headers['ChatGPT-Account-Id'], accountId);
  assert.deepEqual(JSON.parse(posts[0].options.body), { credit_id: credit.id, redeem_request_id: requestId });
  for (code of ['nothing_to_reset', 'already_redeemed', 'no_credit', 'unknown']) {
    await assert.rejects(CGUT.consumeReset(request));
  }
  const before = posts.length;
  await assert.rejects(CGUT.consumeReset({ ...request, accountId: 'default' }));
  assert.equal(posts.length, before);
});

test('a failed POST is never automatically retried', async () => {
  let posts = 0;
  const { CGUT } = context(async (url) => {
    if (url.endsWith('/api/auth/session')) return session();
    posts++;
    throw new Error('connection lost');
  });
  await assert.rejects(CGUT.consumeReset({ accountId, creditId: credit.id, requestId }));
  assert.equal(posts, 1);
});

test('worker serializes duplicate reset requests and refreshes the selected account', async () => {
  const ctx = context();
  let posts = 0;
  const refreshed = [];
  const stored = { usage: ctx.CGUT.normalizeUsage(usage, Date.now(), accountId, resetCredits) };
  ctx.CGUT.consumeReset = async () => { posts++; };
  ctx.CGUT.fetchUsage = async (options) => {
    refreshed.push(options.accountHint);
    return { raw: usage, accountId, fetchedAt: Date.now() + 1, resetCredits: { available_count: 0, credits: [] } };
  };
  ctx.importScripts = () => {};
  let onMessage;
  ctx.chrome = {
    storage: { local: {
      get: async () => stored,
      set: async (value) => Object.assign(stored, value),
    } },
    runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, onInstalled: { addListener() {} } },
    windows: { onCreated: { addListener() {} } },
  };
  vm.runInContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), ctx);
  const send = (message) => new Promise((resolve) => onMessage(message, {}, resolve));
  const request = { type: 'cgut:use-reset', accountId, creditId: credit.id, requestId };
  const [first, second] = await Promise.all([send(request), send(request)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(posts, 1);
  assert.equal(stored.usage.manualResets.length, 0);
  assert.ok(refreshed.every((id) => id === accountId));
  assert.equal((await send({ ...request, accountId: requestId })).ok, false);
  assert.equal(posts, 1);
});

// A small DOM double keeps interaction checks runnable with Node and no extension dependencies.
function element() {
  const classes = new Set();
  return {
    children: [], attributes: {}, listeners: {}, hidden: false, style: {}, dataset: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
    },
    append(...nodes) {
      this.children.push(...nodes);
      for (const node of nodes) if (typeof node === 'object') node.parent = this;
    },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    remove() { this.parent.children = this.parent.children.filter((node) => node !== this); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    focus() {},
    click() { if (!this.disabled) this.listeners.click?.(); },
  };
}

test('panel hides empty/expired lists, requires confirmation, supports cancel and blocks duplicate clicks', async () => {
  const ctx = context();
  ctx.document = { createElement: element };
  ctx.crypto = { randomUUID };
  const requests = [];
  let finish;
  ctx.chrome = { runtime: { sendMessage: (request) => {
    requests.push(request);
    return new Promise((resolve) => { finish = resolve; });
  } } };
  vm.runInContext(readFileSync(new URL('../shared/ui.js', import.meta.url), 'utf8'), ctx);
  const panel = new ctx.CGUT.ui.UsagePanel();
  const normalized = ctx.CGUT.normalizeUsage(usage, Date.now(), accountId, resetCredits);
  panel.render({ usage: null });
  assert.equal(panel.resets.hidden, true);
  panel.render({ usage: normalized });
  assert.equal(panel.resets.hidden, false);
  const row = panel.resetRows.get(credit.id);
  assert.equal(panel.resets.children[0].textContent, 'Available Resets');
  assert.equal(row.title.textContent, 'Weekly Reset');
  assert.equal(row.button.textContent, 'Use Reset');
  assert.equal(row.root.children.length, 2); // details and actions, with no confirmation message
  assert.equal(row.root.children[0].children[0], row.title);
  assert.equal(row.root.children[1].children[0], row.button);
  assert.ok(row.expiry.textContent.includes(String(new Date(future).getFullYear())));
  row.button.click();
  assert.equal(requests.length, 0);
  assert.equal(row.cancel.hidden, false);
  assert.equal(row.button.textContent, 'Confirm Reset');
  assert.equal(row.button.classList.contains('cgut-reset-confirm'), true);
  assert.ok(row.cancel.className.includes('cgut-reset-cancel'));
  row.cancel.click();
  assert.equal(row.confirming, false);
  assert.equal(row.button.classList.contains('cgut-reset-confirm'), false);
  assert.equal(requests.length, 0);
  row.button.click();
  // Periodic rendering must preserve the confirmation and its focused button.
  panel.render({ usage: normalized });
  assert.equal(panel.resetRows.get(credit.id), row);
  assert.equal(row.confirming, true);
  row.button.click();
  row.button.click();
  assert.equal(requests.length, 1);
  assert.equal(row.button.disabled, true);
  assert.equal(requests[0].accountId, accountId);
  assert.equal(requests[0].creditId, credit.id);
  finish({ ok: true });
  await new Promise(setImmediate);
  assert.equal(panel.resets.hidden, true);
  panel.render({ usage: normalized }, Date.parse(future));
  assert.equal(panel.resets.hidden, true);
});

test('failed resets require confirmation again, reuse IDs only for uncertain outcomes, and never cross accounts', async () => {
  const ctx = context();
  ctx.document = { createElement: element };
  ctx.crypto = { randomUUID };
  const requests = [];
  let reuseRequestId = false;
  ctx.chrome = { runtime: { sendMessage: async (request) => {
    requests.push(request);
    return { ok: false, error: 'Your usage does not need a Reset right now.', reuseRequestId };
  } } };
  vm.runInContext(readFileSync(new URL('../shared/ui.js', import.meta.url), 'utf8'), ctx);
  const panel = new ctx.CGUT.ui.UsagePanel();
  const normalized = ctx.CGUT.normalizeUsage(usage, Date.now(), accountId, resetCredits);
  panel.render({ usage: normalized });
  const row = panel.resetRows.get(credit.id);
  row.button.click();
  row.button.click();
  await new Promise(setImmediate);
  assert.equal(panel.resetStatus.hidden, false);
  assert.match(panel.resetStatus.textContent, /does not need/);
  assert.match(panel.resetStatus.textContent, /a Reset/);
  assert.equal(row.button.disabled, false);
  row.button.click();
  row.button.click();
  await new Promise(setImmediate);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  reuseRequestId = true;
  row.button.click();
  row.button.click();
  await new Promise(setImmediate);
  row.button.click();
  row.button.click();
  await new Promise(setImmediate);
  assert.equal(requests[2].requestId, requests[3].requestId);
  row.button.click();
  panel.render({ usage: { ...normalized, accountId: requestId } });
  row.button.click();
  assert.equal(requests.length, 4);
  assert.equal(panel.resetRows.get(credit.id).confirming, false);
});
