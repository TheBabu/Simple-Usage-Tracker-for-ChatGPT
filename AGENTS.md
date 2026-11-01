# AGENTS.md

Instructions for coding agents (Codex, Claude Code, Cursor, Copilot, Gemini CLI and others) and for
anyone else working on this repo. This is the one copy; tool-specific files such as `CLAUDE.md`
only point here.

## What this is

A Chrome extension (Manifest V3) that shows ChatGPT's 5-hour, weekly and credit usage: in a bar
inside the message box on chatgpt.com, in a sidebar section, and in the toolbar popup. It is plain
JavaScript that Chrome loads as is: no bundler, no framework, no runtime dependencies. Minimum
Chrome 111. The only site it talks to is chatgpt.com.

## Layout

| Path | What it does |
|---|---|
| `manifest.json` | Permissions are `storage` plus the chatgpt.com host, and nothing else. |
| `background.js` | Service worker. Owns the shared state in `chrome.storage.local` (usage, last error, monthly credit ledger, debug log) and serializes writes to it. Fetches only when the popup asks and no chatgpt.com tab can. Opens the Release Notes page after an update. |
| `content/tracker.js`, `tracker.css` | Runs on chatgpt.com: polls usage, notices replies, draws the bar in the message box and the sidebar section. Everything that depends on ChatGPT's markup is in `SELECTORS` at the top. |
| `shared/usage.js` | Fetching and normalizing usage, and formatting. Used by the worker, the content script and the popup. |
| `shared/ui.js`, `ui.css` | Progress bars, rows and the tooltip shared by the sidebar and the popup. |
| `popup/` | The toolbar popup: usage, options (percentages as used or left, and the bar in the message box can be turned off), and a Debug section with the log and the last raw response. |
| `release-notes/` | The Release Notes page. The notes themselves, written for users, are in `changelog.json`, which GitHub releases use too; `versions.js` compares versions for the page, the worker and the release script. |
| `scripts/build.mjs` | Packs `dist/*.zip`. Fails if a script doesn't parse or the manifest names a missing file; warns when the version has no release notes. |
| `scripts/release-notes.mjs` | Writes the GitHub release notes from `release-notes/changelog.json`. |
| `.github/workflows/release.yml` | A build on every PR; a release when `main` gets a new version, with its notes from `release-notes/changelog.json`. |

The scripts share code through one global, `globalThis.CGUT`, so load order matters: `usage.js`
first, then `ui.js` or `release-notes/versions.js` add to it. The shipped code uses no ES modules, because
content scripts can't.

## Commands

Node 22 or newer.

- `npm run build`: packs `dist/simple-tracker-for-chatgpt-v<version>.zip`.
- `npm test`: checks reset handling and composer mode detection.
- By hand: `chrome://extensions` → Developer mode → Load unpacked → the repo root. After an edit,
  press Reload on the extension, then reload the chatgpt.com tab for content script changes.

Before you call a change done:

1. `npm run build` passes.
2. If you can, load the extension in a browser and check the change yourself; don't hand that to
   the maintainer. For anything you couldn't check (most things on chatgpt.com need a signed-in
   account), say what wasn't tested.

## Code style

Match the code around you:

- **Shape:** each script is `'use strict'` plus one IIFE. Two-space indent, single quotes,
  semicolons, `const`/`let`, arrow functions for callbacks. `.editorconfig` has the formatting.
- **Comments:** plain sentences about *why*: what ChatGPT does, timing, edge cases. No JSDoc.
  Update a comment when the behaviour it describes changes.
- **Dependencies and permissions:** add no dependency or build step to the shipped code. Add a
  permission only with a strong reason, because each one shows in Chrome's install prompt and the
  store review.
- **User-facing text:** short and plain, in sentence case ("Resets in 4h 28m").
- **Colours:** use ChatGPT's own theme variables with fallbacks (see `shared/ui.css`), so light and
  dark mode follow the page.

## Working against chatgpt.com

ChatGPT's markup changes often, and none of it is a public API.

- **Selectors:** all of them live in `SELECTORS` in `content/tracker.js`. When the bar or sidebar
  section stops appearing, start there. Find elements by what they do rather than by class name,
  since Tailwind class names churn. For example, the message box is "the nearest rounded, painted
  ancestor of the input".
- **Usage data:** it comes from `GET /backend-api/wham/usage`, using the page's own session token.
  Never read or send conversation content.
- **Replies:** don't wrap or patch the page's `fetch`/XHR; that was tried and removed. Replies are
  detected from the stop button and from resource timing.
- **The message box animates.** ChatGPT animates it with framer-motion layout animations: the box
  takes its final size at once and is drawn with transforms in between. While that runs, its
  `border-radius` is written as percentages.
  - The bar opens and closes by animating its own height (see `setBarOpen`), the moment the mode
    changes. It used to wait for the box to hold still first; on today's composer that only made
    it feel slow, so the wait was removed.
  - After a reload ChatGPT first shows a stand-in box, built before its code runs: the input is
    `#pending-home-input`, the send button is `aria-busy` with a spinner, and there is no `<form>`.
    Once its code has loaded (the page is too busy to run anything else meanwhile) it replaces that
    box with the live one. The bar never opens in the stand-in (`SELECTORS.composerLoading`), or
    it gets thrown out with it and comes back moments later.
  - The box is currently a CSS grid, so the bar gives itself a row below the others.
- **Chat vs Work/Codex:** the bar shows in Work and Codex. Mode detection prefers the home
  Composer mode toggle and the Select chat surface button, then explicit surface URLs and known
  placeholders. An unfamiliar placeholder must not be treated as Chat: project, plan and follow-up
  prompts vary. Unknown modes use the initial five-second fallback in `barWanted`; the stand-in
  composer stays excluded until it is replaced. Drafts keep the last known mode on that page.
- **Checking a change to the bar for jitter:** record the box's and bar's geometry on every frame
  (sample in a task queued from `requestAnimationFrame`) while switching Chat ↔ Work. PR #5 has
  the method and the before/after numbers. ChatGPT's live bundle under `chatgpt.com/cdn/assets/`
  (listed in the manifest the `/gpts` page loads) is the reference for its markup and animations.
- **Signing in:** agent sandboxes usually can't sign in to ChatGPT. Mock `/api/auth/session` and
  `/backend-api/wham/usage` instead, and say what wasn't tested live.

## Releases

- **Version bumps:** pushing a new `version` in `manifest.json` to `main` publishes a GitHub
  release automatically. Don't change the version unless the maintainer asks.
- **Release notes:** for a change users would notice, add to the entry for the next version at
  the top of `release-notes/changelog.json`, written for users. The Release Notes page and the
  GitHub release both show it. An update with notes opens the Release Notes page; one without
  updates quietly. See `RELEASING.md`.

## Privacy

The Privacy Policy in `README.md` is a promise to users. Question anything that stores new data,
contacts a new host or reads more of the page, and if it goes ahead, update the policy in the same
change. No analytics and no third-party requests.

## Git

- **Commits:** a short imperative summary ("Stop the composer bar jittering when switching Chat to
  Work"), then a body saying what was wrong and why the change fixes it.
- **Branches:** the maintainer prefers changes pushed straight to `main`, without a pull request
  or a leftover branch. CI only runs on pull requests, so run the checks under "Commands" before
  pushing.
