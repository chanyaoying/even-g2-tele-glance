# TeleGlance handover (session ending 2026-11-05)

For the next agent. Read `AGENTS.md` first (project plan, learnings, per-release notes 1.0.68-1.0.84); this file covers what this session did and what is still open. Repo state: `main`, last commit `38523ae` (pushed), beta channel = **1.0.84** (`app.json`).

## 1. What this session shipped

### App / backend (beta releases 1.0.81 -> 1.0.84)
| Version | Change | Key files |
|---|---|---|
| 1.0.81 | ARIA-style bot messages carry their body in Telegram `rich_message` (page blocks, empty `message`) and rendered blank. Added plain-text converter. Removed the bordered "message card"; long messages now scroll as normal page-sized blocks. | `server/app/services/message_content.py` (`rich_text`), `server/app/services/telegram.py`, `web/src/controller/model.ts` (`formatMessageBlocks`), `tests/backend/test_rich_message.py` |
| 1.0.82 | Faster startup: `init()` starts the chat-list request, reads the stored chat list and draws it first, so "Checking Telegram session..." only shows when nothing is stored. Bridge sends full rebuilds one at a time (`rebuildInFlight`, `render.queued`, 3 s max wait). Settings write to phone storage no longer awaited before the controller is created. | `web/src/controller/appController.ts` (`init`), `web/src/bridge/evenBridge.ts`, `web/src/contexts/AppContext.tsx` |
| 1.0.83 | 1.0.82 could leave the glasses with no interactive page. Startup (`createStartUpPageContainer`) now always gets a plain text page; the interactive sidebar follows as a normal rebuild. Uncaught errors/unhandled rejections are sent as `js-error` debug notes. | `evenBridge.ts` (`startupBootstrapped`, `reportUncaughtErrors`) |
| 1.0.84 | Pictures landed before their page (previous page's 20x20 placeholder in the slot) -> "image gone after scrolling back". `GlassesBridge.pageSettled()` resolves when no rebuild is in flight/waiting (max 4 s); `showPanelImage` awaits it. | `evenBridge.ts` (`pageSettled`), `appController.ts` (`showPanelImage`) |

**None of 1.0.82-1.0.84 is verified on real glasses.** The causal explanations (overlapping rebuilds causing refused pages; startup-page type causing the dead page) are hypotheses, flagged as such in `AGENTS.md`.

### Test infrastructure (commit `38523ae`, no release; not a beta change)
- Simulator `@evenrealities/evenhub-simulator` pinned to **0.9.5** (was 0.7.2). It renders the glasses framebuffer: `/api/screenshot/glasses` returns a real 576x288 PNG (monochrome green; simulator font, so pixels differ from hardware). The old "blank PNG" notes were removed.
- Headless run works on this Linux box under Xvfb (see section 3).
- `scripts/simulator-flow.mjs` changes: software-render env vars for the simulator, 90 s ping wait (simulator needs ~25 s to start), liveness probe only counts failures after the first successful ping (before: it declared the simulator dead during startup and skipped every step), `--budget-scale` / `TELEGLANCE_BUDGET_SCALE`, saves `<step>.glasses.png` per step, creates `frames/` dir, `matchesRenderContract` understands `panelFooter`, `popupTitle`, `popupBodyContains`, `popupBodyNotContains`.
- `web/src/testMode.ts` `summarizeScreenModel` now includes `popup` and `panelImage` for sidebar models (so goldens capture the confirm dialog and picture slot).
- `web/src/fixtureApi.ts`: new chat **Fixture Media** (index 5, `fixture-chat-5`) with text, a photo (`Sunset photo [photo]`, id 51), a sticker (`[sticker]`, id 52) and a closing text. `getPhoto` returns real 288x120 greyscale PNGs (sunset / smiley) instead of a 1x1 placeholder.
- Catalog (`docs/UI_INVARIANTS.json` + `.md`): steps `53`, `53a` (sticker page, must emit `image`), `53b` (photo page, must emit `image`), `53c` (back). Steps 18/18a/21c/21d/28 rewritten (they asserted the removed card), 36/52 rewritten (they asserted the `newMessage` screen removed in 1.0.76). Recording/confirm render contracts updated; confirm screens now declare `left`/`right` (required by `web/test/ui-invariants.test.ts` for sidebar-kind screens).
- All `web/test/simulator-goldens/*.glasses.json` regenerated.

## 2. Validation status at handover
- `npm test --prefix web`: 298 pass. `npm run typecheck --prefix web`: clean.
- Backend: `PYTHONPYCACHEPREFIX=.pycache server/.venv/bin/python -m pytest tests/backend` -> 139 pass. `server/.venv` is gitignored; recreate with `uv venv --python 3.12 server/.venv && uv pip install -p server/.venv -r server/requirements-dev.txt` (system `python3 -m venv` lacks ensurepip here).
- Simulator flow (fixture mode): exit 0, **zero warnings**, 63+ glasses PNGs, compared against the new goldens (run once with `--update-goldens`, once without).

## 3. How to run things
```bash
# Packages needed once (Ubuntu 26.04): libgtk-3-0t64 libwebkit2gtk-4.1-0 libsoup-3.0-0 libjavascriptcoregtk-4.1-0 xvfb
xvfb-run -a npm run test:simulator --prefix web -- --budget-scale 2            # compare
xvfb-run -a npm run test:simulator --prefix web -- --budget-scale 2 --update-goldens   # after intentional UI change
# artifacts: artifacts/simulator-flow/<timestamp>/{report.md,latency.json,steps/<step>.glasses.png,...}  (gitignored; only newest kept)
```
Release flow (unchanged): bump `app.json` version, `rm` old `.ehpk`, `export BACKEND_ORIGIN=https://teleglance.homelab.chanyaoying.com`, `npm run configure:tailscale --prefix web`, `node scripts/upload.mjs --publish -m "<changelog>"`, `git push`.

Reading what the phone is doing (needs "Debug events" on in the phone's Settings): `docker logs teleglance | grep -E "page-rebuild|image-transfer|js-error|image.settle"`. Recent events can also be read from `/api/debug/events` inside the container (script described in `AGENTS.md`, 1.0.83 note).

## 4. Gotchas learned this session
- Simulator 0.9.5 under Xvfb needs `WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1`; startup ~25 s; software rendering makes steps ~1.5-2x slower than catalog budgets (hence `--budget-scale 2`).
- `summarizeScreenModel` output is what goldens contain. The popup was invisible in goldens before; now included. Picture pixels are only visible in the PNG.
- A thread opens on its **newest** page; with the media fixture that page is only the closing text, so pictures appear after swiping up (that is why steps 53a/53b exist).
- The simulator transfers images instantly. It cannot reproduce the glasses-link stalls (seconds, occasional 8 s timeouts) behind slow/missing pictures.
- Telegram session expiry, forum `topic.id` vs `topMessageId`, byte-bounded containers etc.: see `AGENTS.md` "Observed Issues and Learnings".
- User preference: Sonnet attribution line on commits per the session's system reminder; user runs privileged commands themselves (`! sudo ...`), no sudo available to the agent.

## 5. Open items / suggested next steps (highest value first)
1. **Real-glasses verification of 1.0.82-1.0.84.** Ask the user to open the app cold, scroll a photo thread, scroll away and back to a photo, with Debug events on; then read `page-rebuild` (accepted/durationMs), `image-transfer` (ok/durationMs) and `js-error` notes. This decides whether the serialized-rebuild and `pageSettled` changes worked and whether to build any speed-ups.
2. **Footer text vs behaviour ("Hold to record").** Thread footer says `Swipe scroll | Hold to record | Double click back`, recording screen says `Release to stop`, but `AGENTS.md` says single press starts/stops recording because the SDK has no hold. Simulator 0.9.x does emulate long-press (and `evenhub_sdk` may expose it). Check `appController.ts` / `eventMapping.ts` for what actually triggers recording and fix either the labels or the notes.
3. **Footer clipping when scrolled back.** The `Older messages | N newer | Swipe scroll | Hold to record | Double` footer is cut off in the simulator PNG; "Double click back" (the way out) is the part lost. Shorten the footer when scrolled back. Check against real glasses first.
4. **Calibrate the 26 px row height** used to place the picture slot (`38 + 4 + topLine * 26 + 3`). Needs one photo of a real thread page on the glasses to compare against the simulator PNG.
5. Optional sticker work (user has not approved): show the sticker emoji instead of a bare `[sticker]` (backend must send it); start picture fetch earlier and warm pictures of neighbouring pages. Do only after step 1 shows where the time goes.
6. Picture/popup fidelity gaps: the fixture has no multi-photo page or photo+day-divider case; popup opacity on real glasses is unverified (`AGENTS.md` popups note).
7. Housekeeping from `AGENTS.md` Pending Checklist still applies (QA matrix for backgrounding/idle, backend-unreachable retry state, send debounce, packaging script, etc.).

## 6. Files touched this session (for orientation)
`server/app/services/{message_content,telegram}.py`, `tests/backend/test_rich_message.py`, `web/src/controller/{model,appController}.ts`, `web/src/bridge/evenBridge.ts`, `web/src/contexts/AppContext.tsx`, `web/src/{fixtureApi,testMode}.ts`, `web/test/{evenBridge,controller,model}.test.ts`, `scripts/simulator-flow.mjs`, `docs/UI_INVARIANTS.{json,md}`, `web/test/simulator-goldens/*`, `AGENTS.md`, `app.json` (1.0.84).
