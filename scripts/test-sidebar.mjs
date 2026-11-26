import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/tracker.js', import.meta.url), 'utf8');
const shellMarker = '[data-sidebar-navigation-root]';
const scrollMarker = '[data-app-action-sidebar-scroll]';
const activeRailDestination = '[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"]';

function element(...selectors) {
  return {
    selectors,
    children: [],
    visibility: 'visible',
    hasLayout: true,
    classList: { add() {} },
    addEventListener() {},
    setAttribute() {},
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove();
      this.append(...children);
    },
    append(...children) {
      for (const child of children) this.insertBefore(child, null);
    },
    get parentElement() { return this.parent ?? null; },
    get nextElementSibling() {
      return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null;
    },
    insertBefore(child, before) {
      child.remove();
      const i = before === null ? this.children.length : this.children.indexOf(before);
      assert.ok(i >= 0);
      child.parent = this;
      this.children.splice(i, 0, child);
    },
    remove() {
      if (!this.parent) return;
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    matches(selector) {
      return selector.split(', ').some((value) => this.selectors.includes(value));
    },
    closest(selector) {
      return this.matches(selector) ? this : this.parent?.closest(selector);
    },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0];
    },
    getClientRects() {
      return this.hasLayout && (this.parent?.getClientRects().length ?? 1) ? [{}] : [];
    },
  };
}

function sidebar(...pageChildren) {
  const document = element();
  document.createElement = () => element();
  document.append(...pageChildren);
  const frames = [];
  const ui = {
    el: () => element(),
    createPct: () => ({ root: element() }),
    createProgress: () => ({ root: element() }),
    UsagePanel: class { root = element(); resets = element(); resetList = element(); resetStatus = element(); },
  };
  const ctx = vm.createContext({
    CGUT: { ui }, document,
    location: { pathname: '/' },
    getComputedStyle: (node) => ({ visibility: node.visibility }),
    requestAnimationFrame: (callback) => frames.push(callback),
  });
  vm.runInContext(source.replace(/  init\(\)\.catch\([^\n]+;/,
    '  CGUT.sidebar = { findSidebarAnchor, isUsageDestination, onMountMutations, mountSidebar, removeSidebar, sidebar };'), ctx);
  return { ...ctx.CGUT.sidebar, frames, location: ctx.location };
}

test('uses the active chat scroller and skips destinations that retain it offscreen', () => {
  const shell = element(shellMarker);
  const home = element('nav[aria-label="Chat history"]');
  const scroll = element(scrollMarker);
  home.append(scroll);
  shell.append(home, element('nav[aria-label="Space"]'), element('nav[aria-label="Scheduled task folders"]'),
    element('nav[aria-label="Customize"]'));
  const otherScroll = element(scrollMarker);
  const { findSidebarAnchor } = sidebar(shell, otherScroll, element('#history'));

  assert.equal(findSidebarAnchor().node, scroll);
  assert.equal(findSidebarAnchor().mode, 'afterFirstChild');
  home.hasLayout = false;
  assert.equal(findSidebarAnchor(), null);
  home.hasLayout = true;
  scroll.visibility = 'hidden';
  assert.equal(findSidebarAnchor().node, home);
  scroll.visibility = 'visible';
  assert.equal(findSidebarAnchor().node, scroll);
});

test('only Home and Codex show usage when the active rail destination is marked', () => {
  for (const name of ['home', 'codex', 'space', 'customize', 'automations', 'library', 'pull-requests']) {
    const destination = element(activeRailDestination, `[data-sidebar-destination="builtin:${name}"]`);
    const { isUsageDestination } = sidebar(destination);
    assert.equal(isUsageDestination(), name === 'home' || name === 'codex', name);
  }
});

test('direct links to feature tabs hide usage while the rail is loading', () => {
  const { isUsageDestination, location } = sidebar();
  for (const pathname of ['/space', '/spaces/one', '/scheduled', '/plugins/one', '/skills']) {
    location.pathname = pathname;
    assert.equal(isUsageDestination(), false, pathname);
  }
  for (const pathname of ['/', '/c/one', '/codex/tasks/one']) {
    location.pathname = pathname;
    assert.equal(isUsageDestination(), true, pathname);
  }
});

test('chooses the active shell and skips collapsed sidebars and the icon rail', () => {
  const active = element('[data-slate-sidebar-content]');
  const inactive = element(shellMarker, '[data-app-shell-active-page="false"]');
  const rail = element('[data-app-navigation-rail]');
  const scroll = element(scrollMarker);
  rail.append(element(scrollMarker));
  active.append(rail, scroll);
  inactive.append(element(scrollMarker));
  const { findSidebarAnchor } = sidebar(active, inactive, element('#history'));

  assert.equal(findSidebarAnchor().node, scroll);
  active.selectors.push('[data-sidebar-collapsed]');
  assert.equal(findSidebarAnchor(), null);
  inactive.selectors.pop();
  assert.equal(findSidebarAnchor().node, inactive.children[0]);
});

test('keeps the legacy history and navigation fallbacks', () => {
  const nav = element('nav[aria-label="Chat history"]');
  const history = element('#history');
  nav.append(history);
  const { findSidebarAnchor } = sidebar(nav);
  assert.equal(findSidebarAnchor().node, history);
  assert.equal(findSidebarAnchor().mode, 'before');
  history.hasLayout = false;
  assert.equal(findSidebarAnchor().node, nav);
  assert.equal(findSidebarAnchor().mode, 'append');
});

test('queues a remount for sidebar visibility changes and ignores unrelated animations', () => {
  const shell = element(shellMarker);
  const retained = element();
  retained.append(element(scrollMarker));
  shell.append(retained);
  const activeTab = element(activeRailDestination);
  for (const [target, attributeName] of [[retained, 'style'], [shell, 'class'], [activeTab, 'aria-current']]) {
    const { onMountMutations, frames } = sidebar(shell, activeTab);
    onMountMutations([{ target: element(), attributeName: 'style' }]);
    assert.equal(frames.length, 0);
    onMountMutations([{ target, attributeName }]);
    assert.equal(frames.length, 1);
  }
});

test('mounts Usage and Available Resets as independent native sidebar siblings', () => {
  const shell = element(shellMarker);
  const scroll = element(scrollMarker);
  const newChat = element();
  const projects = element('[data-app-action-sidebar-section]');
  const recents = element('[data-app-action-sidebar-section]');
  scroll.append(newChat, projects, recents);
  shell.append(scroll);
  const { mountSidebar, removeSidebar, sidebar: panel } = sidebar(shell);
  const usage = panel.usage.root;
  const resets = panel.resets.root;

  mountSidebar();
  assert.deepEqual(scroll.children, [newChat, usage, resets, projects, recents]);
  // Already mounted: don't move either section or trigger another mutation.
  const insertBefore = scroll.insertBefore;
  scroll.insertBefore = () => assert.fail('Unexpected remount');
  mountSidebar();
  scroll.insertBefore = insertBefore;

  // ChatGPT can replace the scroller or omit the New chat row.
  const replacement = element(scrollMarker);
  replacement.append(projects, recents);
  scroll.remove();
  shell.append(replacement);
  mountSidebar();
  assert.deepEqual(replacement.children, [usage, resets, projects, recents]);
  replacement.hasLayout = false;
  mountSidebar();
  assert.deepEqual(replacement.children, [projects, recents]);
  replacement.hasLayout = true;
  mountSidebar();
  removeSidebar();
  assert.deepEqual(replacement.children, [projects, recents]);
});

test('mounts both sidebar sections in the legacy history fallback', () => {
  const nav = element('nav[aria-label="Chat history"]');
  const history = element('#history');
  nav.append(history);
  const { mountSidebar, sidebar: panel } = sidebar(nav);
  mountSidebar();
  assert.deepEqual(nav.children, [panel.usage.root, panel.resets.root, history]);
  history.hasLayout = false;
  mountSidebar();
  assert.deepEqual(nav.children, [history, panel.usage.root, panel.resets.root]);
});
