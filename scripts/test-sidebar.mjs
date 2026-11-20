import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/tracker.js', import.meta.url), 'utf8');
const shellMarker = '[data-sidebar-navigation-root]';
const scrollMarker = '[data-app-action-sidebar-scroll]';
const headerMarker = '[class~="pb-(--sidebar-scroll-header-spacing)"]';

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
      this.children = [];
      this.append(...children);
    },
    append(...children) {
      for (const child of children) child.parent = this;
      this.children.push(...children);
    },
    get nextElementSibling() {
      return this.parent?.children[this.parent.children.indexOf(this) + 1];
    },
    contains(node) {
      return node === this || Boolean(node.parent && this.contains(node.parent));
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
    getComputedStyle: (node) => ({ visibility: node.visibility }),
    requestAnimationFrame: (callback) => frames.push(callback),
  });
  vm.runInContext(source.replace(/  init\(\)\.catch\([^\n]+;/,
    '  CGUT.sidebar = { findSidebarAnchor, onMountMutations };'), ctx);
  return { ...ctx.CGUT.sidebar, frames };
}

test('uses the sidebar shell while a destination has no chat scroller', () => {
  const shell = element(shellMarker);
  const home = element('nav[aria-label="Chat history"]');
  const scroll = element(scrollMarker);
  home.append(scroll);
  shell.append(home, element('nav[aria-label="Scheduled task folders"]'), element('nav[aria-label="Plugins"]'));
  const otherScroll = element(scrollMarker);
  const { findSidebarAnchor } = sidebar(shell, otherScroll, element('#history'));

  assert.equal(findSidebarAnchor().node, scroll);
  home.hasLayout = false;
  assert.equal(findSidebarAnchor().node, shell);
  assert.equal(findSidebarAnchor().mode, 'prepend');
  home.hasLayout = true;
  scroll.visibility = 'hidden';
  assert.equal(findSidebarAnchor().node, shell);
  scroll.visibility = 'visible';
  assert.equal(findSidebarAnchor().node, scroll);
});

test('uses the scroll area below the active sidebar header', () => {
  const shell = element(shellMarker);
  const home = element();
  const homeBody = element();
  const chatScroll = element(scrollMarker);
  homeBody.append(chatScroll);
  home.append(element(headerMarker), homeBody);
  const destinations = [element(), element(), element()];
  for (const view of destinations) {
    view.hasLayout = false;
    view.append(element(headerMarker), element('.overflow-y-auto'));
  }
  shell.append(home, ...destinations);
  const { findSidebarAnchor } = sidebar(shell);

  assert.equal(findSidebarAnchor().node, chatScroll);
  assert.equal(findSidebarAnchor().mode, 'afterFirstChild');
  home.hasLayout = false;
  for (const view of destinations) {
    view.hasLayout = true;
    assert.equal(findSidebarAnchor().node, view.children[1]);
    assert.equal(findSidebarAnchor().mode, 'prepend');
    view.hasLayout = false;
  }
});

test('places Usage after a visible header while the destination is loading', () => {
  const shell = element(shellMarker);
  const header = element(headerMarker);
  shell.append(header, element());
  const { findSidebarAnchor } = sidebar(shell);
  assert.equal(findSidebarAnchor().node, header);
  assert.equal(findSidebarAnchor().mode, 'after');
});

test('chooses the active shell and skips collapsed sidebars and the icon rail', () => {
  const active = element('[data-slate-sidebar-content]');
  const inactive = element(shellMarker, '[data-app-shell-active-page="false"]');
  const rail = element('[data-app-navigation-rail]');
  rail.append(element(scrollMarker));
  active.append(rail);
  const { findSidebarAnchor } = sidebar(active, inactive, element('#history'));

  assert.equal(findSidebarAnchor().node, active);
  active.selectors.push('[data-sidebar-collapsed]');
  assert.equal(findSidebarAnchor(), null);
  inactive.selectors.pop();
  assert.equal(findSidebarAnchor().node, inactive);
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
  const header = element(headerMarker);
  retained.append(header);
  for (const [target, attributeName] of [[retained, 'style'], [shell, 'class'], [header, 'style']]) {
    const { onMountMutations, frames } = sidebar(shell);
    onMountMutations([{ target: element(), attributeName: 'style' }]);
    assert.equal(frames.length, 0);
    onMountMutations([{ target, attributeName }]);
    assert.equal(frames.length, 1);
  }
});
