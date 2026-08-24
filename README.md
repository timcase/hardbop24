# Hard Bop 24

A single-page web player for **Hard Bop 24**, a 24-hour hard bop internet radio station streamed
from `radio.lysn.bar` (station shortcode `hardbop24`). Installable as a PWA, with offline-capable
shell caching, live "now playing" metadata, play history, and automatic stream reconnection.

No framework, no build step — plain HTML, CSS, and JavaScript served as static files.

## Features

- Streams Opus (128 kbps) with automatic fallback to MP3 (320 kbps) if a browser can't play the
  primary mount.
- Live "now playing" track info (title, artist, album, original release year) polled independently
  of playback, so a metadata hiccup never interrupts the audio.
- Recent play history with per-track artwork and relative timestamps.
- Automatic reconnection with backoff on stream drops, network loss, or stalls.
- Installable as a standalone PWA with an offline app shell via a service worker.

## Running locally

```
bin/serve [port]
```

Serves `src/` the way Vercel serves production (web root at `/`), defaulting to port 8765. Then
open `http://localhost:<port>/`.

After editing `player.js` or `player.css`, reload the page **twice** — the service worker serves
those files stale-while-revalidate, so the first load after a change still shows the old version.

## Deployment

Deployed on Vercel. `vercel.json` sets `outputDirectory` to `src`, so pushing/merging to the
connected branch is the only deploy step needed.

## Project structure

```
src/
  index.html            Page markup
  player.js             All application logic (playback, metadata, history, reconnection)
  player.css            Styles
  sw.js                 Service worker (offline shell, caching strategy)
  manifest.webmanifest   PWA manifest
  icons/, fonts/        Static assets
bin/serve               Local dev server
vercel.json              Vercel deployment config (output dir, cache headers)
```
