import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadTracker } from './helpers/tracker.mjs';

function composer({ placeholder = '', surface = '', search = '', pathname = '/', pressed = -1, chatComposer = false } = {}) {
  let now = 10000;
  const classes = new Set();
  const timers = new Set();
  const node = (_tag, className = '') => {
    const ownClasses = new Set(className.split(' '));
    return {
      append() {}, replaceChildren() {}, addEventListener() {}, setAttribute() {},
      classList: {
        add: (name) => ownClasses.add(name),
        remove: (name) => ownClasses.delete(name),
        toggle: (name, force) => force ? ownClasses.add(name) : ownClasses.delete(name),
        contains: (name) => ownClasses.has(name),
      },
      closest: () => null,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ width: 0 }),
      get isConnected() { return !!this.parentElement?.isConnected; },
      remove() {
        if (this.parentElement?.lastElementChild === this) this.parentElement.lastElementChild = null;
        this.parentElement = null;
      },
      style: {},
    };
  };
  const input = {
    ...node(), matches: (selector) => selector.includes('textarea'), tagName: 'TEXTAREA', placeholder,
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
    chrome: {},
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
    getComputedStyle: (element) => ({ visibility: 'visible', ...element.computedStyle }),
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout: (callback) => timers.delete(callback),
  });
  return {
    ...loadTracker(ctx, ['detectMode', 'updateMode', 'barWanted', 'mountBar', 'bar', 'state']),
    advance: () => { now += 6000; },
    hasClass: (name) => classes.has(name),
    finishTimers() {
      for (const callback of timers) callback();
      timers.clear();
    },
  };
}

function composerBox({ rows = 2, pending = false, loading = '' } = {}) {
  const input = {
    id: pending ? 'pending-home-input' : 'prompt-textarea',
    matches: (selector) => pending && selector.includes('#pending-home-input'),
    closest: () => null,
  };
  const box = {
    tagName: 'DIV',
    attributes: [],
    isConnected: true,
    matches: () => false,
    closest: () => null,
    getClientRects: () => [{}],
    loading,
    querySelector(selector) {
      if (input.matches(selector)) return input;
      if (this.loading && selector.includes(this.loading)) return {};
      return null;
    },
    append(element) {
      element.remove();
      element.parentElement = this;
      this.lastElementChild = element;
    },
    get computedStyle() {
      const bar = this.lastElementChild;
      const barRow = bar && !bar.hidden ? Number(bar.style.gridRowStart) || 0 : 0;
      return {
        display: 'grid',
        borderTopLeftRadius: '24px',
        backgroundColor: 'white',
        gridTemplateRows: Array(Math.max(rows, barRow)).fill('18px').join(' '),
      };
    },
  };
  input.parentElement = box;
  return { input, box };
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

test('the bar waits for the live composer on page load', () => {
  const c = composer();
  c.state.mode = 'work';
  c.mountBar(composerBox({ pending: true }).input);
  assert.equal(c.bar.root.isConnected, false);
  assert.equal(c.bar.root.hidden, true);

  const { input, box } = composerBox({ loading: 'aria-busy' });
  c.mountBar(input);
  assert.equal(c.bar.root.isConnected, false);
  box.loading = '';
  c.mountBar(input);
  assert.equal(c.bar.root.parentElement, box);
  assert.equal(c.bar.root.hidden, false);
});

test('the bar stays open while a live composer sends a message', () => {
  const c = composer();
  c.state.mode = 'work';
  const { input, box } = composerBox();
  c.mountBar(input);
  c.finishTimers();

  for (const loading of ['aria-busy', 'animate-spin']) {
    box.loading = loading;
    c.mountBar(input);
    assert.equal(c.bar.root.parentElement, box, loading);
    assert.equal(c.bar.root.hidden, false, loading);
    assert.equal(c.bar.root.classList.contains('cgut-bar-moving'), false, loading);
  }
});

test('a replacement composer gets the same open bar in its own grid row', () => {
  const c = composer();
  c.state.mode = 'codex';
  const initial = composerBox({ rows: 3 });
  c.mountBar(initial.input);
  c.finishTimers();
  assert.equal(c.bar.root.style.gridRowStart, '4');

  initial.box.isConnected = false;
  const replacement = composerBox({ rows: 1, loading: 'aria-busy' });
  c.mountBar(replacement.input);
  assert.equal(c.bar.root.parentElement, replacement.box);
  assert.equal(c.bar.root.hidden, false);
  assert.equal(c.bar.root.classList.contains('cgut-bar-closed'), false);
  assert.equal(c.bar.root.classList.contains('cgut-bar-moving'), false);
  assert.equal(c.bar.root.style.gridRowStart, '2');
});
