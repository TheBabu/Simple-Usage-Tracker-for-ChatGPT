import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/tracker.js', import.meta.url), 'utf8');

function composer({ placeholder = '', surface = '', search = '', pathname = '/', pressed = -1, chatComposer = false } = {}) {
  let now = 10000;
  const classes = new Set();
  const node = () => ({
    append() {}, replaceChildren() {}, addEventListener() {}, setAttribute() {},
    classList: { add() {} }, closest: () => null, getClientRects: () => [{}],
  });
  const input = {
    ...node(), matches: () => true, tagName: 'TEXTAREA', placeholder,
    closest: (selector) => selector === '[data-chatgpt-composer]' && chatComposer ? {} : null,
  };
  const toggle = pressed < 0 ? null : {
    ...node(),
    querySelectorAll: () => [0, 1].map((index) => ({ getAttribute: () => String(index === pressed) })),
  };
  const ui = {
    el: node,
    createPct: () => ({ root: node() }),
    createProgress: () => ({ root: node() }),
    UsagePanel: class { root = node(); resets = node(); resetList = node(); resetStatus = node(); },
  };
  const ctx = vm.createContext({
    CGUT: { ui },
    document: {
      createElement: node,
      documentElement: {
        dataset: {},
        classList: {
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
          remove: (name) => classes.delete(name),
        },
      },
      querySelectorAll: (selector) => {
        if (selector.includes('Composer mode')) return toggle ? [toggle] : [];
        if (selector.includes('Select chat surface')) return surface ? [{ ...node(), textContent: surface }] : [];
        return [input];
      },
    },
    location: { search, pathname },
    Date: class extends Date { static now() { return now; } },
    URLSearchParams,
    setTimeout() {},
  });
  // Inspect the real content-script decisions without starting polling or a browser lifecycle.
  vm.runInContext(source.replace(/  init\(\)\.catch\([^\n]+;/,
    '  CGUT.composer = { detectMode, updateMode, barWanted, setUsagePopupHidden, state };'), ctx);
  return {
    ...ctx.CGUT.composer,
    advance: () => { now += 6000; },
    hasClass: (name) => classes.has(name),
  };
}

test('Work and Codex placeholders show the message-box bar', () => {
  for (const placeholder of ['Work on anything', 'Work with ChatGPT', 'Ask Codex to do anything in the cloud', 'Do anything']) {
    const c = composer({ placeholder });
    c.updateMode();
    assert.equal(c.barWanted(), true);
  }
});

test('new Work, plan, project and follow-up prompts are not mistaken for Chat', () => {
  for (const placeholder of [
    'Ask ChatGPT anything. @ to use plugins or mention files',
    'Describe your task to generate a plan...',
    'New chat in my project',
    'Ask for follow-up changes',
    'Trabaja en cualquier cosa',
  ]) {
    const c = composer({ placeholder });
    c.updateMode();
    assert.equal(c.detectMode(), null);
    assert.equal(c.barWanted(), false);
    c.advance();
    assert.equal(c.barWanted(), true, placeholder);
  }
});

test('Chat stays hidden and explicit controls take precedence over placeholders', () => {
  for (const options of [
    { placeholder: 'Ask anything' },
    { placeholder: 'Ask ChatGPT' },
    { placeholder: '', chatComposer: true },
    { placeholder: 'Work on anything', pressed: 0 },
    { placeholder: 'Ask Codex to do anything in the cloud', surface: 'Chat' },
  ]) {
    const c = composer(options);
    c.updateMode();
    c.advance();
    assert.equal(c.barWanted(), false);
  }
  for (const options of [{ placeholder: 'Ask anything', pressed: 1 }, { surface: 'Codex' }, { surface: 'Work' }]) {
    const c = composer(options);
    c.updateMode();
    assert.equal(c.barWanted(), true);
  }
});

test('Codex URLs and explicit surfaces work without an empty-editor placeholder', () => {
  for (const options of [{ pathname: '/codex' }, { pathname: '/codex/tasks/123' }, { search: '?surface=codex' }, { search: '?surface=work' }]) {
    const c = composer(options);
    c.updateMode();
    assert.equal(c.barWanted(), true);
  }
});

test('the popup setting still disables the bar in Work and Codex', () => {
  for (const surface of ['Work', 'Codex']) {
    const c = composer({ surface });
    c.updateMode();
    c.state.showBar = false;
    assert.equal(c.barWanted(), false);
  }
});

test('the popup setting hides and restores ChatGPT native usage card', () => {
  const c = composer();
  c.setUsagePopupHidden(true);
  assert.equal(c.hasClass('cgut-hide-usage-popup'), true);

  c.setUsagePopupHidden(false);
  assert.equal(c.hasClass('cgut-hide-usage-popup'), false);
});
