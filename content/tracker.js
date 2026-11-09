// The in-page half of the extension: keeps usage fresh while chatgpt.com is open, and draws the bar
// under the composer and the collapsible "Usage" section in the sidebar. Depends on
// shared/usage.js and shared/ui.js.
'use strict';

(() => {
  const CGUT = globalThis.CGUT;
  const { ui } = CGUT;

  const POLL_VISIBLE_MS = 60 * 1000;
  const POLL_HIDDEN_MS = 5 * 60 * 1000;
  const POLL_JITTER_MS = 5 * 1000;          // spreads tabs out so one fetch serves them all
  const FRESH_ON_OPEN_MS = 15 * 1000;       // page loads and tab switches refetch anything older
  const FORCED_MIN_GAP_MS = 2 * 1000;
  const AFTER_REPLY_DELAYS_MS = [2500, 12000]; // credit charges can land a few seconds late
  const SPEND_SETTLE_MS = 20 * 1000;
  const REPLY_DEDUPE_MS = 5 * 1000;         // both reply signals report the same reply finishing
  const EXPIRY_GRACE_MS = 5 * 1000;
  const EXPIRY_RETRY_BASE_MS = 30 * 1000;
  const EXPIRY_RETRY_MAX_MS = 5 * 60 * 1000;
  const MOUNT_WARN_AFTER_MS = 15 * 1000;
  const MODE_WAIT_MS = 5 * 1000;           // after a page load, for ChatGPT to say Chat or Work
  const TICK_MS = 5 * 1000;

  // Everything that depends on ChatGPT's markup lives here, most specific first. When a redesign
  // stops the bar or the sidebar section from appearing, this is the place to look.
  const SELECTORS = {
    // The message input. The bar goes inside the rounded box drawn around it (see findComposerBox).
    composerInput: '[data-composer-input], #prompt-textarea, main [contenteditable="true"], main textarea',
    // How far up from the input that box can be.
    composerRoot: '[data-composer-surface-variant], form',
    // A composer that is still loading. After a reload ChatGPT first shows a stand-in box (its input
    // is #pending-home-input, its send button is busy with a spinner) and replaces it with the live
    // one once its code has loaded.
    composerLoading: '#pending-home-input, button[aria-busy="true"], #composer-submit-button [class*="animate-spin"]',
    // Where the bar goes when no box can be found.
    composer: [
      { selector: '[data-composer-surface-variant]', mode: 'inside' },
      { selector: 'form[data-type="unified-composer"]', mode: 'after' },
      { selector: '#prompt-textarea', closest: 'form', mode: 'after' },
    ],
    modeToggle: '[role="group"][aria-label="Composer mode"]',
    surfaceToggle: 'button[aria-label="Select chat surface"]',
    sidebar: [
      { selector: '[data-app-action-sidebar-scroll]', mode: 'afterFirstChild' },
      { selector: '#history', mode: 'before' },
      { selector: 'nav[aria-label="Chat history"]', mode: 'append' },
    ],
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
    ].join(','),
    // Matched inside the composer box only, where the one "Stop…" button is the reply's.
    stopButtonInBox: 'button[aria-label^="stop" i]',
    // The request a reply streams over. Resource timing doesn't say the method, so this matches the
    // POST endpoint exactly and not /conversation/<id>, which loads an old conversation.
    replyStream: /\/backend-api\/(?:f\/)?conversation(?:[?#]|$)/,
    // The large "You've reached your ... usage limit" notice above or below a conversation.
    usageLimitBanner: 'aside[role="status"]',
  };

  const startedAt = Date.now();

  const state = {
    usage: null,
    error: null,
    ledger: {},
    collapsed: false,
    showBar: true,         // the popup's "Usage bar in the message box" option
    hideUsagePopup: true,  // the popup's "Hide remaining usage popup" option
    hideUsageLimitBanner: true, // the popup's "Hide usage limit reached banner" option
    display: 'used',       // the popup's "Show usage" option: 'used' or 'left'
    inFlight: null,
    lastAttemptAt: 0,
    pollTimer: null,
    expiryRetry: null,     // { at, attempts } while a passed reset time waits for fresh data
    streaming: false,      // the stop button is showing
    pending: null,         // { startBalance, endedAt } for the reply in progress
    lastSpend: null,       // credits the last reply cost, when it cost any
    mountWarned: { bar: false, sidebar: false },
    mode: null,            // 'work' | 'codex' | 'chat' | null (not known yet) for the current page
    modePath: null,
    modeSeen: false,       // a mode has been read since the page loaded
    composerBox: null,     // { input, box } last found by findComposerBox
    barTarget: null,
    barOpen: false,        // shown, or opening
    barSpot: null,         // { node, inside } where the bar was last put
  };

  // ---------- Extension plumbing ----------

  // After the extension is reloaded or updated, this copy of the script is orphaned: its chrome.*
  // calls throw and nothing will ever update it again, so it takes its UI down with it.
  function alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function send(message) {
    if (!alive()) return Promise.resolve(null);
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function log(message) {
    send({ type: 'cgut:log', message });
  }

  function setUsagePopupHidden(hidden) {
    state.hideUsagePopup = hidden;
    document.documentElement.classList.toggle('cgut-hide-usage-popup', hidden);
  }

  function setUsageLimitBannerHidden(hidden) {
    state.hideUsageLimitBanner = hidden;
    // Recheck existing banners now, rather than waiting for the next mount or page reload.
    markUsageLimitBanners();
    document.documentElement.classList.toggle('cgut-hide-usage-limit-banner', hidden);
  }

  function markUsageLimitBanners() {
    for (const banner of document.querySelectorAll(SELECTORS.usageLimitBanner)) {
      const title = banner.querySelector('h3')?.textContent?.trim() || '';
      const isLimit = /^you['’]ve reached your .*usage limit\b/i.test(title);
      banner.classList.toggle('cgut-usage-limit-banner', isLimit);
      // Mark the outer flex item as well: hiding only the aside leaves an empty gap.
      if (banner.parentElement?.classList.contains('contents')) {
        banner.parentElement.parentElement?.classList.toggle('cgut-usage-limit-banner-wrapper', isLimit);
      }
    }
  }

  // ---------- Usage for this page ----------

  function pageAccountId() {
    return document.documentElement.dataset.themeAccountId || null;
  }

  // Stored usage is shared by every tab; ignore it when it belongs to a different workspace than
  // the one this tab is showing.
  function currentUsage() {
    const usage = state.usage;
    const account = pageAccountId();
    if (!usage || !account || usage.accountId === 'default') return usage;
    return usage.accountId === account ? usage : null;
  }

  function readBootstrap() {
    return Promise.resolve(CGUT.parseBootstrap(document.getElementById('client-bootstrap')?.textContent));
  }

  // ---------- Fetching and scheduling ----------

  function pollInterval() {
    return document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  }

  function scheduleNext() {
    clearTimeout(state.pollTimer);
    if (!alive()) return;
    const last = Math.max(currentUsage()?.fetchedAt || 0, state.lastAttemptAt);
    const due = last + pollInterval() + Math.random() * POLL_JITTER_MS;
    state.pollTimer = setTimeout(() => refresh(), Math.max(1000, due - Date.now()));
  }

  // Unforced refreshes skip the request when the shared data is younger than `maxAge`: another tab
  // fetched recently, and every tab sees that result through storage anyway.
  function refresh({ force = false, maxAge = pollInterval() - POLL_JITTER_MS } = {}) {
    if (state.inFlight) return state.inFlight;
    if (!alive()) return Promise.resolve({ ok: false, error: 'Extension was reloaded' });

    const now = Date.now();
    if (force && now - state.lastAttemptAt < FORCED_MIN_GAP_MS) return Promise.resolve({ ok: true, skipped: true });
    const usage = currentUsage();
    if (!force && usage && now - usage.fetchedAt < maxAge) {
      scheduleNext();
      return Promise.resolve({ ok: true, skipped: true });
    }

    state.lastAttemptAt = now;
    state.inFlight = (async () => {
      try {
        const fetched = await CGUT.fetchUsage({ base: location.origin, accountHint: pageAccountId(), readBootstrap });
        await send({ type: 'cgut:store', fetched });
        return { ok: true };
      } catch (e) {
        const error = CGUT.errorRecord(e);
        await send({ type: 'cgut:error', error });
        return { ok: false, error: error.message };
      } finally {
        state.inFlight = null;
        scheduleNext();
      }
    })();
    return state.inFlight;
  }

  // A limit whose reset time has passed needs new data to clear. Ask straight away, then back off
  // while the requests keep failing, so a dead connection does not become a request every tick.
  function checkExpiry(now) {
    const usage = currentUsage();
    const expired = !!usage && [usage.session, usage.weekly].some(
      (w) => w?.resetsAt && w.resetsAt < now - EXPIRY_GRACE_MS && usage.fetchedAt < w.resetsAt,
    );
    if (!expired) {
      state.expiryRetry = null;
      return;
    }
    const retry = state.expiryRetry;
    if (retry && now - retry.at < Math.min(EXPIRY_RETRY_BASE_MS * 2 ** retry.attempts, EXPIRY_RETRY_MAX_MS)) return;
    state.expiryRetry = { at: now, attempts: retry ? retry.attempts + 1 : 0 };
    refresh({ force: true });
  }

  // ---------- Replies and credit spend ----------

  // Two independent signals follow a reply, so a redesign that breaks one still leaves the other:
  // the stop button shows while it streams, and the browser records a resource timing entry for the
  // streamed request when it ends. Neither involves touching the page's own code.
  function updateStreaming() {
    const box = state.composerBox?.box;
    const streaming = !!(document.querySelector(SELECTORS.stopButton) || box?.querySelector(SELECTORS.stopButtonInBox));
    if (streaming === state.streaming) return;
    state.streaming = streaming;
    if (streaming) onReplyStarted();
    else onReplyFinished();
  }

  function watchReplyStreams() {
    try {
      new PerformanceObserver((list) => {
        const finished = list.getEntries().some((entry) =>
          (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') && SELECTORS.replyStream.test(entry.name));
        if (finished) onReplyFinished();
      }).observe({ type: 'resource' });
    } catch {
      // No resource timing: the stop button alone still works.
    }
  }

  function currentBalance() {
    return currentUsage()?.credits?.balance ?? null;
  }

  function onReplyStarted() {
    state.pending = { startBalance: currentBalance(), endedAt: null };
    state.lastSpend = null;
    renderBar();
  }

  // When the start went unseen, the balance now is still the one from before the reply: charges
  // only post after it ends.
  function onReplyFinished() {
    const now = Date.now();
    const pending = state.pending;
    if (pending?.endedAt && now - pending.endedAt < REPLY_DEDUPE_MS) return;
    if (pending && !pending.endedAt) {
      pending.endedAt = now;
    } else {
      state.pending = { startBalance: currentBalance(), endedAt: now };
      state.lastSpend = null;
    }
    for (const delay of AFTER_REPLY_DELAYS_MS) setTimeout(() => refresh({ force: true }), delay);
    renderBar();
  }

  // Compares the balance against where it stood when the reply started. Only a drop is shown; the
  // window stays open briefly after the reply because charges can post late.
  function trackSpend(now) {
    const pending = state.pending;
    if (!pending) return;
    const balance = currentBalance();
    if (pending.startBalance !== null && balance !== null && pending.startBalance - balance > 1e-6) {
      state.lastSpend = pending.startBalance - balance;
    }
    if (pending.endedAt && now - pending.endedAt > SPEND_SETTLE_MS) state.pending = null;
  }

  // ---------- Composer bar ----------

  // The bar opens and closes by growing its one grid row from nothing (see tracker.css), so the
  // composer box grows and shrinks smoothly instead of jumping by the bar's height.
  function createBar() {
    const root = ui.el('div', 'cgut-root cgut-bar cgut-bar-closed');
    root.id = 'cgut-bar';
    root.hidden = true;
    const clip = ui.el('div', 'cgut-bar-clip');
    const row = ui.el('div', 'cgut-bar-row');
    const left = ui.el('div', 'cgut-bar-left');
    const label = ui.el('span', 'cgut-bar-label');
    const pct = ui.createPct();
    const progress = ui.createProgress();
    left.append(label, pct.root, progress.root);

    const right = ui.el('div', 'cgut-bar-right');
    const spend = ui.el('span', 'cgut-spend');
    const creditsNote = ui.el('span', 'cgut-credits-note');
    const reset = ui.el('span', 'cgut-bar-reset');
    spend.hidden = true;
    creditsNote.hidden = true;
    right.append(spend, creditsNote, reset);

    row.append(left, right);
    clip.append(row);
    root.append(clip);
    return { root, label, pct, progress, spend, creditsNote, reset };
  }

  const bar = createBar();

  // The same line for the bar and the weekly arrow: "5-hour: 5% used · Resets in 4h 28m", or
  // "95% left" when the popup is set to show what is left.
  function limitTip(win, label, now) {
    const resets = ui.resetText(win.resetsAt, now);
    return `${label}: ${CGUT.formatUsage(win.pct, state.display)}${resets ? ` · ${resets}` : ''}`;
  }

  // The last error, if nothing has loaded since.
  function freshErrorFor(usage) {
    const { error } = state;
    return error && (!usage || error.at > usage.fetchedAt) ? error : null;
  }

  // Turned off in the popup, the bar stays closed; the sidebar section still shows the numbers.
  // Logged out there is nothing to show, and the composer is ChatGPT's sign-up pitch anyway. In
  // Chat mode the limits don't apply, so the bar would only be noise.
  //
  // Right after a page loads the mode isn't known yet, and opening the bar then made it flicker:
  // open, closed when the page turned out to be Chat (or said "Loading..."), open again for Work.
  // So the first time it waits to be told, but not forever, in case the mode can't be read at all.
  // Later on, say after navigating with a draft typed in, an unknown mode keeps the bar showing.
  function barWanted() {
    if (!state.showBar) return false;
    if (freshErrorFor(currentUsage())?.code === 'signed-out') return false;
    if (state.mode) return state.mode !== 'chat';
    return state.modeSeen || Date.now() - startedAt >= MODE_WAIT_MS;
  }

  function renderBar(now = Date.now()) {
    const usage = currentUsage();
    const freshError = freshErrorFor(usage);
    bar.root.classList.toggle('cgut-stale', !!usage && !!freshError);

    const main = usage?.session || usage?.weekly || null;
    if (!main) {
      bar.label.textContent = 'Usage';
      ui.setPctText(bar.pct, freshError ? 'unavailable' : usage ? 'n/a' : '…');
      ui.setTip(bar.pct.root, freshError
        ? `Couldn't load usage: ${freshError.message}`
        : usage ? "ChatGPT isn't reporting any usage limits for this account." : 'Loading usage…');
      ui.setProgress(bar.progress, 0);
      ui.setTip(bar.progress.root, '');
      ui.clearMarker(bar.progress);
      bar.reset.textContent = '';
      bar.spend.hidden = true;
      bar.creditsNote.hidden = true;
      return;
    }

    const isSession = main === usage.session;
    const label = CGUT.windowLabel(main, isSession ? '5-hour' : 'Weekly');
    bar.label.textContent = label;
    ui.setPct(bar.pct, main.pct, state.display);
    ui.setTip(bar.pct.root, '');
    ui.setProgress(bar.progress, main.pct, state.display);
    ui.setTip(bar.progress.root, limitTip(main, label, now));

    if (isSession && usage.weekly) {
      const weeklyTip = limitTip(usage.weekly, CGUT.windowLabel(usage.weekly, 'Weekly'), now);
      ui.setMarker(bar.progress, usage.weekly.pct, weeklyTip, state.display);
    } else {
      ui.clearMarker(bar.progress);
    }

    bar.reset.textContent = ui.resetText(main.resetsAt, now);
    bar.reset.classList.toggle('cgut-resetting', !!main.resetsAt && main.resetsAt <= now);
    ui.setTip(bar.reset, freshError
      ? `Last update failed (${freshError.message}). Showing data from ${CGUT.formatAgo(usage.fetchedAt, now)}.`
      : `Updated ${CGUT.formatAgo(usage.fetchedAt, now)}`);

    // Past the limit, ChatGPT draws on credits; say so and how many are left.
    const showCredits = CGUT.isOverLimit(usage) && CGUT.hasCreditsInfo(usage);
    bar.creditsNote.hidden = !showCredits;
    if (showCredits) {
      bar.creditsNote.textContent = usage.credits.unlimited
        ? 'Using credits'
        : `Using credits · ${CGUT.formatCredits(usage.credits.balance ?? 0)} left`;
    }

    bar.spend.hidden = !state.lastSpend;
    if (state.lastSpend) {
      bar.spend.textContent = `−${CGUT.formatCredits(state.lastSpend)} credits`;
      ui.setTip(bar.spend, 'Credits used by your last message');
    }
  }

  // ---------- Sidebar section ----------

  const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';

  function createSidebar() {
    const root = ui.el('section', 'cgut-root cgut-sidebar');
    root.id = 'cgut-sidebar';

    const header = ui.el('button', 'cgut-sidebar-header');
    header.type = 'button';
    const title = ui.el('span', 'cgut-sidebar-title', 'Usage');
    const chevron = ui.el('span', 'cgut-chevron');
    chevron.innerHTML = CHEVRON_SVG;
    header.append(title, chevron);
    header.addEventListener('click', () => {
      if (alive()) chrome.storage.local.set({ sidebarCollapsed: !state.collapsed });
    });

    const body = ui.el('div', 'cgut-sidebar-body');
    const panel = new ui.UsagePanel();
    body.append(panel.root);

    root.append(header, body);
    return { root, header, body, panel };
  }

  const sidebar = createSidebar();

  function setCollapsed(collapsed) {
    state.collapsed = collapsed;
    sidebar.root.classList.toggle('cgut-collapsed', collapsed);
    sidebar.body.hidden = collapsed;
    sidebar.header.setAttribute('aria-expanded', String(!collapsed));
  }

  function renderSidebar(now = Date.now()) {
    const usage = currentUsage();
    sidebar.panel.render({ usage, error: state.error, ledger: state.ledger, display: state.display }, now);
  }

  function render() {
    const now = Date.now();
    trackSpend(now);
    renderBar(now);
    renderSidebar(now);
  }

  // ---------- Mounting ----------

  function isVisible(node) {
    return node.getClientRects().length > 0;
  }

  // The main composer is the last visible one: an inline "edit message" composer sits above it.
  function lastVisible(selector) {
    const nodes = [...document.querySelectorAll(selector)].filter(isVisible);
    return nodes[nodes.length - 1] || null;
  }

  // While ChatGPT animates the box's size (framer-motion layout animations, e.g. on a Chat/Work
  // switch), the radius is rewritten as percentages of the box ("3.6% 47.8%"), so those are turned
  // back into pixels. Read as plain numbers they looked like no rounding at all, and the bar was
  // thrown out under the box until the animation ended.
  function cornerRadius(node, style) {
    const [x, y = x] = style.borderTopLeftRadius.split(' ');
    const px = (value, size) => (value.endsWith('%') ? (parseFloat(value) / 100) * size : parseFloat(value)) || 0;
    return Math.min(px(x, node.offsetWidth || 0), px(y, node.offsetHeight || 0));
  }

  function paintsRoundedBox(node) {
    const style = getComputedStyle(node);
    if (cornerRadius(node, style) < 12) return false;
    const bg = style.backgroundColor;
    const transparent = bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' || /\/\s*0\)$/.test(bg);
    return !transparent || style.backgroundImage !== 'none' || style.boxShadow !== 'none';
  }

  // The rounded box ChatGPT draws around the message input: the nearest ancestor of the input that
  // paints a background with rounded corners. Which element that is differs between the home page
  // and a conversation, so it is found by looking rather than by name. The search stops at the
  // composer's outer element so it can never wander out into the page.
  //
  // It is searched for afresh every time rather than remembered: across a Chat/Work switch the
  // element painting the box changes, and a remembered outer box can stay painted (in the page's
  // own color) after an inner one takes over, which left the bar stuck underneath the box.
  function findComposerBox(input) {
    let box = null;
    for (let node = input.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
      if (paintsRoundedBox(node)) {
        box = node;
        break;
      }
      if (node.matches(SELECTORS.composerRoot)) break;
    }
    state.composerBox = box && { input, box };
    return box;
  }

  function findComposer() {
    const input = lastVisible(SELECTORS.composerInput);
    const box = input && findComposerBox(input);
    if (box) return { node: box, mode: 'inside' };

    for (const { selector, closest, mode } of SELECTORS.composer) {
      const nodes = [...document.querySelectorAll(selector)]
        .map((node) => (closest ? node.closest(closest) : node))
        .filter((node) => node && isVisible(node));
      if (nodes.length) return { node: nodes[nodes.length - 1], mode };
    }
    return null;
  }

  function findSidebarAnchor() {
    for (const { selector, mode } of SELECTORS.sidebar) {
      const node = document.querySelector(selector);
      if (node) return { node, mode };
    }
    return null;
  }

  // Placed inside the composer like a footer, unless the composer lays its children out in a row,
  // where it would squeeze in beside the input; then it goes underneath instead.
  function isRowFlex(node) {
    const style = getComputedStyle(node);
    return style.display.includes('flex') && !style.flexDirection.startsWith('column');
  }

  // How long .cgut-bar's transition runs. Not a delay: the clip that hides the content while the
  // row grows comes off once the bar has finished opening, so this has to match tracker.css.
  const BAR_ANIM_MS = 260;

  let barTimer = null;

  function setBarOpen(open) {
    const el = bar.root;
    if (state.barOpen === open) return;
    state.barOpen = open;
    clearTimeout(barTimer);
    el.classList.add('cgut-bar-moving');
    if (open) {
      el.hidden = false;
      el.getBoundingClientRect(); // lays it out closed first, so it opens from nothing
    }
    el.classList.toggle('cgut-bar-closed', !open);
    barTimer = setTimeout(() => {
      el.classList.remove('cgut-bar-moving');
      if (!state.barOpen) el.hidden = true;
    }, BAR_ANIM_MS + 30);
  }

  function dropBar() {
    clearTimeout(barTimer);
    bar.root.remove();
    bar.root.hidden = true;
    bar.root.classList.add('cgut-bar-closed');
    bar.root.classList.remove('cgut-bar-moving');
    state.barOpen = false;
    state.barSpot = null;
  }

  // In a grid the bar would take the first free cell, which can be an empty row at the top of the
  // box. It gets a row of its own below the rows already there instead (not counting its own, when
  // it is still there closing).
  function gridRowAfterLast(node) {
    const rows = getComputedStyle(node).gridTemplateRows.replace(/\[[^\]]*\]/g, ' ').trim();
    const count = rows && rows !== 'none' ? rows.split(/\s+/).length : 0;
    const own = bar.root.parentElement === node && !bar.root.hidden ? 1 : 0;
    return Math.max(1, count - own + 1);
  }

  function placeBar(node, inside) {
    const el = bar.root;
    const placed = inside ? el.parentElement === node && node.lastElementChild === el : node.nextElementSibling === el;
    if (!placed) {
      if (inside) node.append(el);
      else node.after(el);
    }
    if (!state.barOpen) {
      const grid = inside && getComputedStyle(node).display.includes('grid');
      el.style.gridRowStart = grid ? String(gridRowAfterLast(node)) : '';
    }
    state.barSpot = { node, inside };
    if (node !== state.barTarget) {
      state.barTarget = node;
      log(`Composer bar placed ${inside ? 'inside' : 'after'} ${describeNode(node)}`);
    }
  }

  function mountBar() {
    const target = findComposer();
    if (!target) {
      dropBar();
      return false;
    }
    const { node, mode } = target;
    const inside = mode === 'inside' && !isRowFlex(node);

    if (!barWanted()) {
      setBarOpen(false);
      return true;
    }
    const spot = state.barSpot;
    if (state.barOpen && bar.root.isConnected && spot?.node === node && spot.inside === inside) {
      placeBar(node, inside); // the page may have added something after it
      return true;
    }
    // The box was replaced or changed layout under the bar: take it out and open it again in the
    // new spot.
    if (state.barOpen) dropBar();
    // A bar put in the stand-in box ChatGPT shows while it loads was thrown out with it moments
    // later and came back in the live box. So it waits for the live box; the swap is a DOM change,
    // so the observer looks again the moment it happens.
    const root = node.closest(SELECTORS.composerRoot) || node;
    if (root.matches(SELECTORS.composerLoading) || root.querySelector(SELECTORS.composerLoading)) return true;
    placeBar(node, inside);
    setBarOpen(true);
    return true;
  }

  // A short label for an element, for the debug log.
  function describeNode(node) {
    const data = [...node.attributes].filter((a) => a.name.startsWith('data-')).slice(0, 3)
      .map((a) => `[${a.name}${a.value ? `="${a.value.slice(0, 20)}"` : ''}]`).join('');
    const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `<${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${cls ? `.${cls}` : ''}${data}>`;
  }

  // ---------- Chat vs Work ----------

  function placeholderOf(input) {
    const field = input.matches('textarea, [contenteditable="true"]')
      ? input
      : input.querySelector('textarea, [contenteditable="true"]');
    if (!field) return '';
    if (field.tagName === 'TEXTAREA') return field.placeholder || field.getAttribute('aria-label') || '';
    return field.querySelector('[data-placeholder]')?.dataset.placeholder || field.getAttribute('aria-placeholder') || '';
  }

  // Show the bar in Work and Codex. Prefer explicit mode controls, then known placeholders.
  // Unfamiliar prompts (including project, plan and follow-up prompts) do not imply Chat mode.
  //
  // While models and plugins load, ChatGPT's placeholder is "Loading..." in either mode, and an
  // empty one is a zero-width space (which trim() keeps). Neither says anything about the mode.
  function detectMode() {
    const toggle = document.querySelector(SELECTORS.modeToggle);
    if (toggle && isVisible(toggle)) {
      const pressed = [...toggle.querySelectorAll('button')].findIndex((b) => b.getAttribute('aria-pressed') === 'true');
      if (pressed !== -1) return pressed === 0 ? 'chat' : 'work';
    }
    const surface = document.querySelector(SELECTORS.surfaceToggle);
    if (surface && isVisible(surface)) {
      const mode = surface.textContent.match(/\b(chat|work|codex)\b/i)?.[1].toLowerCase();
      if (mode) return mode;
    }
    const surfaceParam = new URLSearchParams(location.search).get('surface');
    if (['chat', 'work', 'codex'].includes(surfaceParam)) return surfaceParam;
    if (/^\/codex(?:\/|$)/.test(location.pathname)) return 'codex';
    const input = lastVisible(SELECTORS.composerInput);
    const placeholder = input ? placeholderOf(input).replace(/\u200b/g, '').trim() : '';
    if (/\bcodex\b/i.test(placeholder)) return 'codex';
    if (/\bwork\b/i.test(placeholder)) return 'work';
    if (/^(ask anything|message chatgpt)[.!?…]*$/i.test(placeholder)) return 'chat';
    return null;
  }

  // A rich-text input drops its placeholder once something is typed, so a page keeps the last mode
  // it saw until it navigates (see barWanted for what an unknown mode does).
  function updateMode() {
    if (location.pathname !== state.modePath) {
      state.modePath = location.pathname;
      state.mode = null;
    }
    const mode = detectMode() ?? state.mode;
    if (mode === state.mode) return;
    state.mode = mode;
    if (mode) state.modeSeen = true;
    recheckMountSoon();
  }

  // Switching Chat/Work animates the composer, and which element paints its box can change part
  // way through. Animations don't show up as DOM changes, so look again as it settles.
  const RECHECK_DELAYS_MS = [150, 400, 800, 1500];
  function recheckMountSoon() {
    for (const delay of RECHECK_DELAYS_MS) setTimeout(queueMount, delay);
  }

  function mountSidebar() {
    const target = findSidebarAnchor();
    const el = sidebar.root;
    if (!target) return false;
    const { node, mode } = target;
    if (mode === 'afterFirstChild') {
      const first = node.firstElementChild;
      if (!first) node.append(el);
      else if (first !== el && first.nextElementSibling !== el) first.after(el);
    } else if (mode === 'before') {
      if (node.previousElementSibling !== el) node.before(el);
    } else if (node.lastElementChild !== el) {
      node.append(el);
    }
    return true;
  }

  function ensureMounted() {
    if (!alive()) return teardown();
    // The mode first, so the bar opens or closes in the same frame as a Chat/Work switch.
    updateMode();
    markUsageLimitBanners();
    const mounted = { bar: mountBar(), sidebar: mountSidebar() };

    updateStreaming();

    if (Date.now() - startedAt < MOUNT_WARN_AFTER_MS) return;
    for (const key of ['bar', 'sidebar']) {
      if (!mounted[key] && !state.mountWarned[key]) {
        state.mountWarned[key] = true;
        log(`Couldn't find where to put the ${key === 'bar' ? 'composer bar' : 'sidebar section'}; ChatGPT's layout may have changed.`);
      }
    }
  }

  // ChatGPT re-renders constantly (every streamed token), so checks are batched to one per frame.
  let mountQueued = false;
  function queueMount() {
    if (mountQueued) return;
    mountQueued = true;
    requestAnimationFrame(() => {
      mountQueued = false;
      ensureMounted();
    });
  }

  // ---------- Lifecycle ----------

  let observer = null;
  let tickTimer = null;

  function teardown() {
    observer?.disconnect();
    clearInterval(tickTimer);
    clearTimeout(state.pollTimer);
    bar.root.remove();
    sidebar.root.remove();
    document.documentElement.classList.remove('cgut-hide-usage-popup', 'cgut-hide-usage-limit-banner');
  }

  function tick() {
    if (!alive()) return teardown();
    const now = Date.now();
    ensureMounted();
    checkExpiry(now);
    render();
  }

  async function init() {
    const stored = await chrome.storage.local.get(['usage', 'usageError', 'creditLedger', 'sidebarCollapsed', 'showComposerBar', 'hideUsagePopup', 'hideUsageLimitBanner', 'usageDisplay']);
    state.usage = stored.usage || null;
    state.error = stored.usageError || null;
    state.ledger = stored.creditLedger || {};
    state.showBar = stored.showComposerBar !== false;
    state.display = stored.usageDisplay === 'left' ? 'left' : 'used';
    setUsagePopupHidden(stored.hideUsagePopup !== false);
    setUsageLimitBannerHidden(stored.hideUsageLimitBanner !== false);
    setCollapsed(stored.sidebarCollapsed === true);

    ui.installTooltips();
    render();
    ensureMounted();

    observer = new MutationObserver(queueMount);
    // Attributes too, but only the ones a Chat/Work switch changes, so the bar hides immediately.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['aria-pressed', 'aria-placeholder', 'placeholder', 'data-placeholder'],
    });
    tickTimer = setInterval(tick, TICK_MS);
    setTimeout(queueMount, MODE_WAIT_MS - (Date.now() - startedAt)); // stop waiting for the mode
    document.addEventListener('transitionend', queueMount, true);
    document.addEventListener('animationend', queueMount, true);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.sidebarCollapsed) setCollapsed(changes.sidebarCollapsed.newValue === true);
      if (changes.showComposerBar) {
        state.showBar = changes.showComposerBar.newValue !== false;
        queueMount(); // opens or closes the bar
      }
      if (changes.hideUsagePopup) setUsagePopupHidden(changes.hideUsagePopup.newValue !== false);
      if (changes.hideUsageLimitBanner) {
        setUsageLimitBannerHidden(changes.hideUsageLimitBanner.newValue !== false);
        queueMount();
      }
      if (changes.usageDisplay) {
        state.display = changes.usageDisplay.newValue === 'left' ? 'left' : 'used';
        render();
      }
      if (!changes.usage && !changes.usageError && !changes.creditLedger) return;
      if (changes.usage) state.usage = changes.usage.newValue || null;
      if (changes.usageError) state.error = changes.usageError.newValue || null;
      if (changes.creditLedger) state.ledger = changes.creditLedger.newValue || {};
      if (changes.usage) scheduleNext();
      render();
      queueMount(); // signing out hides the bar
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'cgut:refresh') return false;
      refresh({ force: true }).then(sendResponse);
      return true;
    });

    watchReplyStreams();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return scheduleNext();
      refresh({ maxAge: FRESH_ON_OPEN_MS });
      queueMount();
    });

    refresh({ maxAge: FRESH_ON_OPEN_MS });
  }

  init().catch((e) => log(`Tracker failed to start: ${e.message}`));
})();
