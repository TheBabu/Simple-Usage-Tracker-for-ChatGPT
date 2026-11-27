import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadTracker } from './helpers/tracker.mjs';

const shellMarker = '[data-sidebar-navigation-root]';
const scrollMarker = '[data-app-action-sidebar-scroll]';
const activeRailDestination = '[data-app-navigation-rail] [data-sidebar-destination][aria-current="page"]';

function element(...selectors) {
  const classes = new Set();
  const attributes = {};
  return {
    selectors,
    children: [],
    visibility: 'visible',
    hasLayout: true,
    display: 'block',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
    },
    addEventListener() {},
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name]; },
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
    UsagePanel: class {
      root = element();
      resets = element();
      resetHeading = element();
      resetList = element();
      resetStatus = element();
      note = element();
      constructor() {
        this.resets.append(this.resetHeading, this.resetList);
        this.root.append(this.resets, this.resetStatus, this.note);
      }
    },
  };
  const ctx = vm.createContext({
    CGUT: { ui }, document,
    location: { pathname: '/' },
    getComputedStyle: (node) => ({ visibility: node.visibility, display: node.display, flexDirection: 'column' }),
    requestAnimationFrame: (callback) => frames.push(callback),
  });
  const bindings = loadTracker(ctx, [
    'findSidebarAnchor', 'isUsageDestination', 'onMountMutations', 'mountSidebar', 'removeSidebar',
    'setSeparateResetsDropdown', 'setCollapsed', 'setResetsCollapsed', 'sidebar',
  ]);
  return { ...bindings, frames, location: ctx.location };
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
  const { mountSidebar, removeSidebar, setSeparateResetsDropdown, sidebar: panel } = sidebar(shell);
  setSeparateResetsDropdown(true);
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
  const { mountSidebar, setSeparateResetsDropdown, sidebar: panel } = sidebar(nav);
  setSeparateResetsDropdown(true);
  mountSidebar();
  assert.deepEqual(nav.children, [panel.usage.root, panel.resets.root, history]);
  history.hasLayout = false;
  mountSidebar();
  assert.deepEqual(nav.children, [history, panel.usage.root, panel.resets.root]);
});


test('defaults to a single Usage section and preserves reset rows when switching layouts', () => {
  const shell = element(shellMarker);
  const scroll = element(scrollMarker);
  const projects = element('[data-app-action-sidebar-section]');
  scroll.append(projects);
  shell.append(scroll);
  const { mountSidebar, removeSidebar, setSeparateResetsDropdown, setCollapsed, setResetsCollapsed, sidebar: view } = sidebar(shell);
  const { usage, panel } = view;
  const row = element();
  panel.resetList.append(row);

  mountSidebar();
  assert.deepEqual(scroll.children, [usage.root, projects]);
  assert.equal(panel.resets.parentElement, panel.root);
  assert.deepEqual(panel.resets.children, [panel.resetHeading, panel.resetList]);
  assert.equal(panel.resetStatus.parentElement, panel.root);
  assert.equal(view.resets, null);
  setCollapsed(true);
  assert.equal(usage.body.hidden, true);
  setResetsCollapsed(true);

  setSeparateResetsDropdown(true);
  mountSidebar();
  assert.deepEqual(scroll.children, [usage.root, panel.resets, projects]);
  assert.equal(view.resets.root, panel.resets);
  assert.equal(view.resets.body.hidden, true);
  assert.equal(view.resets.header.getAttribute('aria-expanded'), 'false');
  assert.equal(panel.resetList.parentElement, view.resets.body);
  assert.equal(panel.resetStatus.parentElement, view.resets.body);
  assert.equal(panel.resetList.children[0], row);
  setResetsCollapsed(false);
  assert.equal(view.resets.body.hidden, false);
  assert.equal(usage.body.hidden, true);

  // Expiration/redemption can hide the reset section even when the independent dropdown is open.
  panel.resets.hidden = true;
  setSeparateResetsDropdown(false);
  mountSidebar();
  assert.deepEqual(scroll.children, [usage.root, projects]);
  assert.equal(panel.resets.hidden, true);
  assert.equal(panel.resets.classList.contains('cgut-sidebar'), false);
  assert.deepEqual(panel.resets.children, [panel.resetHeading, panel.resetList]);
  assert.deepEqual(panel.root.children, [panel.resets, panel.resetStatus, panel.note]);
  assert.equal(panel.resetList.children[0], row);
  assert.equal(usage.body.hidden, true);
  removeSidebar();
  assert.deepEqual(scroll.children, [projects]);
  assert.equal(panel.resets.parentElement, panel.root);
  mountSidebar();
  assert.deepEqual(scroll.children, [usage.root, projects]);
  setSeparateResetsDropdown(true);
  mountSidebar();
  assert.equal(panel.resets.hidden, true);
  assert.equal(view.resets.body.hidden, false);
});

test('places Usage above nested conversation sections in Home and Codex', () => {
  for (const destination of ['home', 'codex']) {
    const rail = element(activeRailDestination, `[data-sidebar-destination="builtin:${destination}"]`);
    const shell = element(shellMarker);
    const scroll = element(scrollMarker);
    const group = element();
    const newChat = element();
    const projects = element('[data-app-action-sidebar-section]');
    const recents = element('[data-app-action-sidebar-section]');
    group.append(newChat, projects, recents);
    scroll.append(group);
    shell.append(scroll);
    const { mountSidebar, sidebar: panel, setSeparateResetsDropdown } = sidebar(rail, shell);
    mountSidebar();
    assert.deepEqual(group.children, [newChat, panel.usage.root, projects, recents]);
    setSeparateResetsDropdown(true);
    mountSidebar();
    assert.deepEqual(group.children, [newChat, panel.usage.root, panel.resets.root, projects, recents]);

    // A retained sidebar can move the native sections under a new wrapper on navigation.
    const replacement = element();
    replacement.append(projects, recents);
    group.remove();
    scroll.append(replacement);
    mountSidebar();
    assert.deepEqual(replacement.children, [panel.usage.root, panel.resets.root, projects, recents]);
  }
});

test('does not anchor to hidden native sidebar sections', () => {
  const scroll = element(scrollMarker);
  const hiddenGroup = element();
  hiddenGroup.hasLayout = false;
  hiddenGroup.append(element('[data-app-action-sidebar-section]'));
  const visibleGroup = element();
  const projects = element('[data-app-action-sidebar-section]');
  visibleGroup.append(projects);
  scroll.append(hiddenGroup, visibleGroup);
  const { mountSidebar, sidebar: panel } = sidebar(scroll);
  mountSidebar();
  assert.deepEqual(visibleGroup.children, [panel.usage.root, projects]);
});


test('mounts in the native section layout when New chat is in the fixed header', () => {
  const shell = element(shellMarker);
  const header = element();
  const newChat = element();
  const scroll = element(scrollMarker);
  const layout = element();
  layout.display = 'flex';
  const outerWrapper = element();
  const innerWrapper = element();
  const spacer = element();
  const projectsWrapper = element();
  const recentsWrapper = element();
  const projects = element('[data-app-action-sidebar-section]');
  const recents = element('[data-app-action-sidebar-section]');
  header.append(newChat);
  projectsWrapper.append(projects);
  recentsWrapper.append(recents);
  innerWrapper.append(spacer, projectsWrapper, recentsWrapper);
  outerWrapper.append(innerWrapper);
  layout.append(outerWrapper);
  scroll.append(layout);
  shell.append(header, scroll);
  const { mountSidebar, setSeparateResetsDropdown, sidebar: panel } = sidebar(shell);
  mountSidebar();
  assert.deepEqual(shell.children, [header, scroll]);
  assert.deepEqual(scroll.children, [layout]);
  assert.deepEqual(layout.children, [panel.usage.root, outerWrapper]);
  setSeparateResetsDropdown(true);
  mountSidebar();
  assert.deepEqual(layout.children, [panel.usage.root, panel.resets.root, outerWrapper]);
});
