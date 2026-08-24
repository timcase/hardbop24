# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page PWA front end for the "Hard Bop 24" internet radio station (station 4, shortcode
`hardbop24`, on `radio.lysn.bar`, deployed to `hbop24.lysn.bar` via Vercel). No framework, no
build step, no package.json — plain HTML/CSS/JS served as static files.

## Commands

- `bin/serve [port]` — serve `src/` locally the way Vercel serves production (web root at `/`,
  matching the service worker's scope). Defaults to port 8765; kills any server already bound to
  that port first.
- After editing `player.js` or `player.css`, reload the page **twice** — the service worker serves
  those files stale-while-revalidate, so the first load after a change still shows the old file.
- No test suite, linter, or build command exists in this repo.
- Deploy is via Vercel (`vercel.json` sets `outputDirectory: src`); pushing/merging is the only
  deploy step needed beyond that.

## Architecture

Everything lives in `src/`, which is the deployed web root (`outputDirectory: src` in
`vercel.json`). Three files carry all the logic:

- **`src/index.html`** — static shell/markup only.
- **`src/player.js`** — all behavior. No modules, no bundler; one file, loaded via a plain
  `<script>` tag.
- **`src/sw.js`** — service worker for offline/PWA behavior.

### The audio path and the metadata path are deliberately independent

`player.js` treats live playback and "now playing" info as two unrelated systems that happen to
share a page:

- **Playback**: a `MOUNTS` ladder (`radio.opus` then `radio.mp3`) is tried in order. It does *not*
  gate on `audio.canPlayType()` — that API misreports Opus support on iOS Safari — so the code
  just attempts a mount and reacts to a real failure. `MEDIA_ERR_SRC_NOT_SUPPORTED` on a mount
  that has never produced audio (`mountProven === false`) is treated as a codec problem and
  advances the ladder; the same error on a mount that already played is treated as an outage and
  does not downgrade the listener.
- **Metadata**: polls `METADATA_URL` (AzuraCast's `nowplaying_static` JSON endpoint) every
  `POLL_MS` (10s) with `cache: "no-store"`. This poll never touches the `<audio>` element, so a
  metadata fetch failure can never interrupt playback, and a stream reconnect can never be
  triggered by a metadata problem.
- **Stall detection**: a separate watchdog (`setInterval`, `WATCHDOG_MS`) checks whether
  `audio.currentTime` is advancing, since the media element can report "playing" while the stream
  is actually dead. `STARTUP_LIMIT` (more lenient) applies before the first successful start;
  `STALL_LIMIT` (stricter) applies afterward.
- **Reconnection**: exponential backoff up to `MAX_BACKOFF_MS`, reset on `online` events and on a
  successful `playing` event. `wantsPlayback` (user intent) is tracked separately from
  `audio.paused` (actual element state) because the element also pauses when the connection dies —
  that distinction is what triggers reconnect logic instead of treating it as a user action.

### Artwork

The AzuraCast art endpoint is keyed by media-file ID, not album, so every track on an album would
otherwise be a distinct URL for byte-identical art. `albumArt` (an in-memory `Map`, keyed by
artist+album, not persisted) caches the first URL seen per album to turn repeat plays into cache
hits. New art is decoded off-screen (`Image.decode()`) before being swapped in, with
`ART_TIMEOUT_MS` as a cap so a slow image delays the swap but never blocks metadata rendering
behind it.

### Service worker (`src/sw.js`)

- Cross-origin requests (anything to `radio.lysn.bar`) are left to the browser entirely — the
  stream is unbounded so caching it is unbounded, and stale now-playing data is worse than none.
- Navigations are network-first with the cached shell as an offline fallback, specifically so a
  new deploy takes effect on next load rather than being masked by a stale cached page.
- Other same-origin static assets are cache-first with background revalidation.
- Bump the `CACHE` constant to force a clean re-precache after a shell asset changes.

### Caching headers (`vercel.json`)

`sw.js`, `manifest.webmanifest`, and `player.js`/`player.css` are all served
`no-cache`-equivalent (`max-age=0, must-revalidate`) at the HTTP layer — the service worker's own
stale-while-revalidate behavior is what actually delivers speed, not HTTP caching. Fonts are
immutable/long-cached; icons get a shorter `max-age`.
