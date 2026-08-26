// Hard Bop 24 — station 4, shortcode "hardbop24" on radio.lysn.bar.
// The audio stream and the metadata feed are independent: the metadata path never
// touches the <audio> element, so polling can't interrupt playback.

// Mounts in preference order, tried in sequence. Deliberately NOT gated on
// canPlayType: it reports "" for Ogg/Opus on iOS Safari even though playback works
// there (confirmed on device, and AzuraCast's own player never calls canPlayType at
// all). Predicting support gets it wrong, so attempt it and react to a real failure.
const MOUNTS = [
  {
    url: "https://radio.lysn.bar/listen/hardbop24/radio.opus",
    label: "Opus \u00b7 128 kbps"
  },
  {
    url: "https://radio.lysn.bar/listen/hardbop24/radio.mp3",
    label: "Stereo \u00b7 320 kbps"
  }
];
const METADATA_URL =
  "https://radio.lysn.bar/api/nowplaying_static/hardbop24.json";
const POLL_MS = 10000;

// How long to wait for a new sleeve to decode before showing the track anyway.
const ART_TIMEOUT_MS = 2000;

// Stall watchdog: how often to check for progress, and how many consecutive
// no-progress checks count as a dead stream. A healthy start takes ~2s; the longer
// startup allowance is there to cover reconnecting while the network is still coming
// back up, where treating slowness as a stall would just restart the wait.
const WATCHDOG_MS = 5000;
const STALL_LIMIT = 5;
const STARTUP_LIMIT = 6;

const MAX_BACKOFF_MS = 30000;

// 1x1 transparent GIF, used only if the artwork URL itself fails to load.
const BLANK_ART =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const art = document.getElementById("art");
const titleEl = document.getElementById("title");
const artistEl = document.getElementById("artist");
const albumEl = document.getElementById("album");
const yearEl = document.getElementById("year");
const statusEl = document.getElementById("status");
const onairEl = document.getElementById("onair");
const metaEl = document.getElementById("meta");
const historyEl = document.getElementById("history");
const historyListEl = document.getElementById("history-list");
const specEl = document.getElementById("spec");
const toggle = document.getElementById("toggle");
const audio = document.getElementById("audio");

// Whether the *user* wants sound. Distinct from audio.paused, which also goes true
// when the connection dies — that difference is what drives reconnection.
let wantsPlayback = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
// True only while we are deliberately tearing the stream down to rebuild it, so the
// pause/emptied events that load() fires aren't mistaken for a fresh connection drop.
let reconnecting = false;
let lastTime = -1;
let stallCount = 0;
// Whether the current connection has ever produced audio, which is what separates
// "still buffering" from "stalled".
let hasStarted = false;
let stationOnline = true;
let lastSongId = null;
let lastHistoryKey = null;
let mountIndex = 0;
// True once the current mount has actually produced audio. A mount that has already
// played is not a codec problem, so a later failure on it must be treated as an outage
// rather than a reason to downgrade the listener permanently.
let mountProven = false;

// The art endpoint is keyed by media-file id, not by album, so every track of one album
// has a different URL serving byte-identical bytes. Remembering the first URL seen per
// album turns those into cache hits instead of repeat downloads. Keyed on artist too so
// two records sharing a title cannot collide. Per page load; nothing persisted.
const albumArt = new Map();

/* ---------- metadata ---------- */

function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

// Decode the new sleeve off-screen before it goes on the page, so the type can never
// sit against the previous track's cover. Resolves to a usable URL either way: the
// placeholder if the image fails, and the real URL anyway once ART_TIMEOUT_MS is up, so
// a slow image delays the swap but can never block the metadata behind it.
function resolveArt(song) {
  const key = `${song.artist || ""}\u241f${song.album || ""}`;
  if (!song.album) return song.art || "";

  const known = albumArt.get(key);
  if (known) return known;

  if (song.art) albumArt.set(key, song.art);
  return song.art || "";
}

function loadArt(url) {
  if (!url) return Promise.resolve(BLANK_ART);

  const pending = new Image();
  pending.src = url;

  return Promise.race([
    pending.decode().then(() => url).catch(() => BLANK_ART),
    new Promise((resolve) => setTimeout(() => resolve(url), ART_TIMEOUT_MS))
  ]);
}

function setArt(url) {
  // Reassigning an identical src would re-decode the image and flicker on every poll.
  if (!url) url = BLANK_ART;
  if (art.src === url) return;
  // The markup's fetchpriority="high" only covers the request made at parse time; this
  // element's real src is assigned later, so the hint has to be reapplied here too.
  art.fetchPriority = "high";
  art.src = url;
}

art.addEventListener("error", () => {
  if (art.src !== BLANK_ART) art.src = BLANK_ART;
});

function updateMediaSession(song, artUrl) {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || song.text || "Hard Bop 24",
    artist: song.artist || "",
    album: song.album || "",
    // Sizes are omitted deliberately: artwork dimensions vary per track, and a wrong
    // hint is worse than none — the browser fetches and measures it either way.
    // With no cover, hand the OS the station mark rather than nothing — it is already
    // precached, and a blank lock screen looks like a fault.
    artwork:
      artUrl && artUrl !== BLANK_ART
        ? [{ src: artUrl }]
        : [{ src: "icons/hardbop24-512.png", sizes: "512x512", type: "image/png" }],
  });
}

async function render(song) {
  const key = song.id || song.text || "";
  if (key && key === lastSongId) return;
  lastSongId = key;

  const artUrl = await loadArt(resolveArt(song));

  // A newer track arrived while that was decoding — that render owns the DOM now.
  if (key !== lastSongId) return;

  setText(titleEl, song.title || song.text || "Unknown track");
  setText(artistEl, song.artist || "");

  const album = song.album || "";
  setText(albumEl, album);
  albumEl.classList.toggle("hidden", album === "");

  // AzuraCast auto-assigns this from the file's ORIGINALDATE tag — the year the
  // record actually came out, not a reissue/remaster date.
  const year = (song.custom_fields && song.custom_fields.original_year) || "";
  setText(yearEl, year);
  yearEl.classList.toggle("hidden", year === "");

  setArt(artUrl);
  updateMediaSession(song, artUrl);

  // Restart the entrance animation. Removing the class isn't enough on its own —
  // reading offsetWidth forces the reflow that lets it re-trigger.
  metaEl.classList.remove("enter");
  void metaEl.offsetWidth;
  metaEl.classList.add("enter");
}

// "3m ago" reads at a glance where a clock face demands the listener do the
// subtraction themselves — and every row here is recent enough that words stay short.
function timeAgo(date) {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Words go stale as the clock ticks even when the history list itself hasn't changed,
// so this runs on every poll independent of renderHistory's unchanged-fingerprint skip.
function refreshHistoryTimes() {
  for (const time of historyListEl.querySelectorAll(".history-time")) {
    time.textContent = timeAgo(new Date(time.dateTime));
  }
}

function renderHistory(entries) {
  // sh_id is stable per play, so the joined set is a cheap fingerprint: an unchanged
  // history touches no DOM at all.
  const key = entries.map((e) => e.sh_id).join(",");
  if (key === lastHistoryKey) return;
  lastHistoryKey = key;

  historyEl.classList.toggle("hidden", entries.length === 0);
  if (entries.length === 0) {
    historyListEl.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    const song = entry.song || {};
    const played = new Date(entry.played_at * 1000);

    const time = document.createElement("time");
    time.className = "history-time";
    time.dateTime = played.toISOString();
    time.textContent = timeAgo(played);

    const artist = document.createElement("span");
    artist.className = "history-artist";
    artist.textContent = song.artist || "";

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = song.title || song.text || "Unknown track";

    const album = document.createElement("span");
    album.className = "history-album";
    album.textContent = song.album || "";
    album.classList.toggle("hidden", !song.album);

    const thumb = document.createElement("img");
    thumb.className = "history-art";
    // Explicit dimensions so the row reserves its box and nothing shifts as covers
    // arrive. Deliberately not loading="lazy": every row is visible immediately, so it
    // would only delay them.
    thumb.width = 56;
    thumb.height = 56;
    thumb.decoding = "async";
    thumb.alt = "";
    thumb.src = resolveArt(song) || BLANK_ART;

    const row = document.createElement("li");
    row.className = "history-row";
    row.append(thumb, title, artist, album, time);
    fragment.append(row);
  }

  // One mutation rather than five.
  historyListEl.replaceChildren(fragment);
}

async function refreshMetadata() {
  try {
    // The endpoint sends Cache-Control: max-age=10, which would otherwise let the
    // browser serve a stale copy back to a 10s poll.
    const res = await fetch(METADATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    stationOnline = data.is_online !== false;

    // Both of these go before render(), which awaits artwork decode for up to
    // ART_TIMEOUT_MS — anything sequenced after that await inherits the delay.
    renderHistory(data.song_history || []);
    refreshHistoryTimes();
    refreshStatus();

    const song = data.now_playing && data.now_playing.song;
    if (song) await render(song);
  } catch (err) {
    // A failed poll is not fatal — keep the last known metadata and keep playing.
    console.warn("Now Playing fetch failed:", err);
  }
}

/* ---------- playback + recovery ---------- */

function refreshStatus() {
  // The masthead badge reports the station; the status line reports our connection to it.
  setText(onairEl, stationOnline ? "On air" : "Off air");
  onairEl.classList.toggle("off", !stationOnline);

  let message = "";
  if (reconnectTimer || reconnecting) message = "Reconnecting";
  else if (!navigator.onLine) message = "No connection";

  setText(statusEl, message);
  statusEl.classList.toggle("hidden", message === "");
}

function activeMount() {
  return MOUNTS[mountIndex];
}

function showMount() {
  setText(specEl, activeMount().label);
}

// Returns false when the ladder is exhausted.
function advanceMount() {
  if (mountIndex >= MOUNTS.length - 1) return false;
  mountIndex++;
  mountProven = false;
  showMount();
  console.warn("Falling back to", activeMount().label);
  return true;
}

function startPlayback() {
  wantsPlayback = true;
  if (!audio.src) audio.src = activeMount().url;
  audio.play().catch((err) => {
    console.warn("Playback rejected:", err);
    // NotAllowedError means the autoplay policy blocked us and retrying is pointless;
    // anything else is a stream problem worth another attempt.
    if (err.name === "NotAllowedError") wantsPlayback = false;
    else scheduleReconnect();
  });
}

function stopPlayback() {
  wantsPlayback = false;
  reconnecting = false;
  cancelReconnect();
  audio.pause();
  resetWatchdog();
  refreshStatus();
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

function scheduleReconnect() {
  if (!wantsPlayback || reconnectTimer) return;

  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  refreshStatus();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectNow();
  }, delay);
}

function reconnectNow() {
  if (!wantsPlayback) return;

  // Reassigning src and calling load() forces a brand new connection; a live stream has
  // nothing to resume, so this always rejoins at the current broadcast moment. It also
  // abandons a socket that died with the network still holding it open.
  resetWatchdog();
  reconnecting = true;
  audio.src = activeMount().url;
  audio.load();
  audio.play().catch((err) => {
    console.warn("Reconnect failed:", err);
    reconnecting = false;
    scheduleReconnect();
  });
}

function resetWatchdog() {
  lastTime = -1;
  stallCount = 0;
  hasStarted = false;
}

// Detects the silent failure the media element does not report: still "playing",
// but currentTime has stopped advancing.
setInterval(() => {
  if (!wantsPlayback || audio.paused || reconnecting || reconnectTimer) return;

  if (audio.currentTime === lastTime) {
    stallCount++;
    if (stallCount >= (hasStarted ? STALL_LIMIT : STARTUP_LIMIT))
      scheduleReconnect();
  } else {
    lastTime = audio.currentTime;
    stallCount = 0;
  }
}, WATCHDOG_MS);

toggle.addEventListener("click", () => {
  if (wantsPlayback) stopPlayback();
  else startPlayback();
});

// Drive the label from the element's own state so it can never desync from reality.
function setLabel() {
  setText(toggle, audio.paused ? "Play" : "Pause");
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }
}

audio.addEventListener("play", setLabel);
audio.addEventListener("pause", () => {
  setLabel();
  // Paused without the user asking means the connection dropped underneath us.
  if (wantsPlayback && !reconnecting) scheduleReconnect();
});
audio.addEventListener("playing", () => {
  reconnecting = false;
  cancelReconnect();
  resetWatchdog();
  hasStarted = true;
  mountProven = true;
  setLabel();
  refreshStatus();
});
audio.addEventListener("waiting", () => setText(toggle, "Cueing"));
audio.addEventListener("error", () => {
  const err = audio.error;
  console.warn("Stream error:", err && err.message, "code", err && err.code);

  // MEDIA_ERR_SRC_NOT_SUPPORTED: this browser genuinely cannot play this mount. Move
  // down the ladder and retry at once — backing off would only delay a switch that has
  // nothing to do with the network.
  // The same code is reported for a mount that is simply down, so only treat it as a
  // codec problem if this mount has never played. Otherwise it is an outage, and
  // downgrading would strand the listener on MP3 long after the mount came back.
  if (err && err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && !mountProven) {
    if (advanceMount()) {
      cancelReconnect();
      reconnectNow();
    } else {
      wantsPlayback = false;
      setText(statusEl, "Stream unavailable");
      statusEl.classList.remove("hidden");
      setLabel();
    }
    return;
  }

  // Anything else is transient — network, decode, abort — and the existing backoff,
  // watchdog and online-handler behaviour is already tuned for it.
  scheduleReconnect();
});

window.addEventListener("online", () => {
  // The network is back, so whatever backoff had escalated to during the outage is now
  // meaningless — reset it and retry at once. Deliberately not gated on audio.paused:
  // a reconnect attempt made while the network was down leaves the element unpaused,
  // playing into a socket that will never deliver another byte.
  if (wantsPlayback) {
    cancelReconnect();
    reconnectNow();
  }
  refreshStatus();
});
window.addEventListener("offline", refreshStatus);

// iOS Safari can silently freeze playback when another app takes audio focus: the
// element still reports paused === false, but currentTime stops advancing (the same
// failure the stall watchdog above exists to catch). Waiting for that watchdog's normal
// cadence here would take up to STALL_LIMIT * WATCHDOG_MS after the tab is back in view,
// so probe immediately on return instead of waiting for the next scheduled check.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!wantsPlayback || reconnecting || reconnectTimer) return;

  const probeTime = audio.currentTime;
  setTimeout(() => {
    if (!wantsPlayback || reconnecting || reconnectTimer) return;
    if (audio.currentTime === probeTime) scheduleReconnect();
  }, 1500);
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", startPlayback);
  navigator.mediaSession.setActionHandler("pause", stopPlayback);
  navigator.mediaSession.setActionHandler("stop", stopPlayback);
}

showMount();
refreshStatus();
refreshMetadata();
setInterval(refreshMetadata, POLL_MS);

if ("serviceWorker" in navigator) {
  addEventListener("load", () =>
    navigator.serviceWorker
      .register("./sw.js")
      .catch((err) => console.warn("Service worker registration failed:", err))
  );
}
