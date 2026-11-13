# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LaterOn is a Manifest V3 Chrome/Edge extension (minimum Chrome 121) for saving web pages into projects and reading them later from a full-screen library or the browser side panel. It is plain JavaScript loaded with classic `<script>` tags — no bundler, no package.json, no npm dependencies. The UI is Chinese by default with an English option; all user data stays in `chrome.storage.local`.

Run it by loading the repo root as an unpacked extension at `chrome://extensions` (Developer mode). After edits, click Reload on the extension card; injected content scripts are executed fresh on demand.

## Commands

```bash
# Single test (plain Node, no runner)
node tests/url-utils.test.js

# jsdom-based tests (36 of 55) need jsdom on NODE_PATH; it is not vendored
NODE_PATH=/path/to/node_modules node tests/delete-item.test.js

# All tests that do not need jsdom
for f in $(grep -L 'require("jsdom")' tests/*.test.js); do node "$f" || break; done

# Design preview pages (outputs are gitignored: tests/*-preview.html)
node tests/build-board-preview.js
node tests/build-dialog-preview.js
node tests/build-preview.js

# Release archive -> dist/LaterOn-<version>.zip
python scripts/build-release.py
```

## Architecture

### Process model

```
sidepanel / library / settings  (each keeps an in-memory copy)
        │ chrome.runtime.sendMessage
        ▼
background service worker  ──queueItemWrite──▶  chrome.storage.local
        │ chrome.storage.onChanged
        ▼
all open extension pages re-render
```

- `background.js` is the MV3 service worker. `importScripts("url-utils.js", "reading-position-background.js", "webdav-sync.js")` at the top. It owns commands (`Alt+1` save, `Alt+Shift+1` save all tabs, `Alt+2` translate), context menus, the `lo` omnibox keyword, side-panel action behavior, the auto-clean alarm, metadata extraction, and the project-picker injection. The worker is ephemeral: never rely on in-memory state persisting.
- `webdav-sync.js` implements optional manual WebDAV backup/restore. It is loaded by the worker (not a page) and talks to the server with `fetch`; it avoids PROPFIND/XML because `DOMParser` is unavailable in service workers. Sync is local-wins and manual: upload overwrites the remote JSON; restore overwrites local data after a UI confirmation.
- Extension pages: `library.html` (full-screen library: project board on the home view, card list inside a project / Inbox / archive), `sidepanel.html`, `settings.html`. They load classic scripts in a fixed order; shared modules are `theme.js` (`LaterOnSettings`), `i18n.js` (`LaterOnI18n`), `dialog.js` (`LaterOnDialog`), `picker-ui.js` (`openFolderPicker`), `tab-navigation.js` (`LaterOnTabs`), `url-utils.js` (`LaterOnUrl`). Keep `theme.js`, `i18n.js`, `url-utils.js`, `tab-navigation.js` before page scripts.
- Content scripts are injected on demand with `chrome.scripting.executeScript`; they are **not** declared in `manifest.json`:
  - `content-metadata.js` — extracts title/description/image/favicon/source. Contains SPA safeguards: YouTube reads live DOM and validates og:image against the video ID in the URL; Douyin settles the feed before reading. Background may refetch server OG tags when the record is incomplete.
  - `content-translation.js` — toggles page translation.
  - `picker-ui.js` + `content-folder-picker.js` — project-picker overlay. `picker-ui.js` is shared with extension pages; `content-folder-picker.js` adapts the background payload and messages.
  - `content-reading-position.js` — "continue where you left off" prompt; reads/writes scroll positions via the worker.
- Injected files must be self-contained IIFEs that are safe to inject repeatedly into the same page (clean up previous globals, no leaking top-level `const`/`let`) and may only assume globals injected before them (`window.openFolderPicker`).
- `reading-position-background.js` is imported by the service worker and owns the tab listeners for reading positions.

### Data and write model

`chrome.storage.local` is the single source of truth. Both UI pages mirror it in memory and re-render from `chrome.storage.onChanged`; one view's action must propagate to the other through shared keys, never through a second cache.

**Item writes go through the worker.** Interactive add/update/delete/auto-clean operations are sent as messages (`MUTATE_ITEMS`, `SAVE_ITEM`, `QUICK_SAVE_TAB`) and handled by `queueItemWrite`, which serializes read-modify-write against the latest stored list. Deleting an item also removes its uploaded cover, its ids from every order list, and clears `laterOnCurrentItem` if it pointed at it. Pages write projects, covers, order, active project/filter, current item, and settings directly.

Storage keys (local unless noted):

| Key | Shape / purpose |
| --- | --- |
| `laterOnItems` | array of saved pages |
| `laterOnProjects` | array of projects |
| `laterOnCovers` | `{ itemId: dataURL }` uploaded covers |
| `laterOnOrder` | `{ scope: [itemId] }` custom order; scope is `all`, `unfiled`, or a project id |
| `laterOnSettings` | theme, language, defaultSort, autoMarkRead, askFolderOnBatch, askFolderOnSingle, autoCleanDays |
| `laterOnCurrentItem` | id of the page currently being read (shared highlight + locate) |
| `laterOnActiveProject` | selected project scope, shared by both views |
| `laterOnFilter` / `laterOnFilterChosen` | shared read filter (`all`/`unread`/`done`) and whether the user chose it |
| `laterOnReadingPositions` | `{ itemId: scrollY }` |
| `laterOnWebdav` | WebDAV config (`url`, `username`, `password`, `path`) and last sync/restore/error status |
| `laterOnDiag` / `laterOnPanelDiag` | diagnostics displayed on the settings page |
| `laterOnOnboardingSeen` | onboarding flag |
| `laterOnPendingBatch` (session) | tabs awaiting a project choice during batch save |
| `laterOnPanelCache` (page `localStorage`) | ≤12-item side-panel first-paint snapshot |

- Item: `{ id, title, description, image, favicon, source, projectId, url, savedAt, status, read, doneAt }`. `status` is `unread | reading | done`; legacy `read` is kept in sync. `projectId: null` means the Inbox ("等待整理"). `doneAt` drives auto-clean. `image` is a remote URL, `local://<itemId>` (payload in `laterOnCovers`), or a legacy `data:` URL migrated on open.
- Project: `{ id, name, createdAt, pinned?, archived? }`. Pinned projects sort first; archived projects are hidden from normal lists and search, but their items remain. Deleting a project deletes its items.
- `saveItem` deduplicates by normalized URL and merges missing metadata into the existing record instead of creating a second entry.
- Side panel → full-screen handoff: the side panel sends `OPEN_LIBRARY`; `openLibrary` reuses an existing library tab and passes context via URL (`from=sidepanel&project=&filter=&focus=`), which `library.js` reads in `init()`.

### URL identity

`url-utils.js` (`LaterOnUrl.normalize`) is the only definition of "same page": it lowercases the host, strips `www`, hash, and tracking params (`utm_*`, `fbclid`, `gclid`, `mc_*`, `ref`, `spm`, `igshid`), sorts the remaining query params, and trims trailing slashes. YouTube watch/shorts/embed/live/youtu.be URLs are canonicalized to `https://youtube.com/watch?v=<id>` (the video ID is case-sensitive). Use it wherever URLs are compared — duplicate detection in `saveItem`, and open-tab reuse in `tab-navigation.js` (`LaterOnTabs.findOpen/activate`).

### Internationalization and theme

- UI copy lives in `i18n.js` dictionaries (`zh-CN`, `en`), consumed via `LaterOnI18n.t(key, vars)`; static markup uses `data-i18n*` attributes plus `applyStatic()`. Add both languages when adding copy.
- `_locales/{zh_CN,en}/messages.json` only holds manifest/command strings (`__MSG_*`), not UI copy.
- `theme.js` applies `document.documentElement.dataset.theme` (`light | dark | system`) from `laterOnSettings.theme` and watches changes. Colors are CSS variables in `theme-vars.css`.

### Performance constraints (load-bearing)

- `background.js` has an 80 KB cold-start budget enforced by `tests/background-modules.test.js`; page-executed functions must stay in the injected `content-*.js` files. The file currently exceeds the cap (≈81 KB), so that test fails until it shrinks.
- The side panel must paint before storage returns: it draws a ≤12-item `localStorage` snapshot inside a `boot.js` skeleton, then reconciles with `chrome.storage`. Card rendering is batched (side panel: 8 first, then idle; library: 48). Avoid adding blocking awaits before first render.
- Uploaded covers are stored outside the item array so list reads stay small; keep the `local://` indirection.
- The side panel lazy-loads `dialog.js`/`dialog.css` on first use (`ensureDialogLoaded`), not at startup.

## Testing

- Tests are plain Node scripts using `assert`, with no framework or runner. Many are integration-style: they load the real HTML and JS into JSDOM, mock `chrome.*` with in-memory stores, and assert user-visible behavior (DOM, storage writes, messages). Others build a `vm` context with mocked `chrome`.
- `tests/helpers/item-mutation.js` slices `mutateItems` out of `background.js` by text markers (from `async function mutateItems(` to `async function usesEnglish()`); keep those functions adjacent or update the helper.
- `tests/background-modules.test.js` is a structural guard: background size cap, heavy functions must live in `content-*.js`, and the injection calls must reference the expected files.
- `tests/build-*.js` generate preview HTML; they are not tests.

## Release

- `manifest.json` `version` is the only version source. Add a newest-first `CHANGELOG.md` entry in Chinese (version scheme `主版本.功能版本.修复版本`).
- `python scripts/build-release.py` builds a deterministic `dist/LaterOn-<version>.zip` from an explicit `RUNTIME_FILES` allowlist, includes `LICENSE`, validates manifest file references, and rejects development files. Any new runtime file must be added to that allowlist; `_locales/` is included wholesale.
- Release packages must not contain README, CHANGELOG, tests, scripts, or design/preview assets.

## Conventions

- Existing comments and user-facing copy are Chinese-first, with English added for the English UI. Follow that style when editing.
- The project is MIT-licensed; distributed derivatives must retain the copyright and license notice.
