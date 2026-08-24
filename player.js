// Hard Bop 24 — station 4, shortcode "hardbop24" on radio.lysn.bar.
// The audio stream and the metadata feed are independent: the metadata path never
// touches the <audio> element, so polling can't interrupt playback.

const STREAM_URL = "https://radio.lysn.bar/listen/hardbop24/radio.mp3";
const METADATA_URL = "https://radio.lysn.bar/api/nowplaying_static/hardbop24.json";
const POLL_MS = 10000;

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
const statusEl = document.getElementById("status");
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

/* ---------- metadata ---------- */

function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

function setArt(url) {
  // Reassigning an identical src would re-decode the image and flicker on every poll.
  if (!url) url = BLANK_ART;
  if (art.src === url) return;
  art.src = url;
}

art.addEventListener("error", () => {
  if (art.src !== BLANK_ART) art.src = BLANK_ART;
});

function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || song.text || "Hard Bop 24",
    artist: song.artist || "",
    album: song.album || "",
    // Sizes are omitted deliberately: artwork dimensions vary per track, and a wrong
    // hint is worse than none — the browser fetches and measures it either way.
    artwork: song.art ? [{ src: song.art }] : []
  });
}

function render(song) {
  const key = song.id || song.text || "";
  if (key && key === lastSongId) return;
  lastSongId = key;

  setText(titleEl, song.title || song.text || "Unknown track");
  setText(artistEl, song.artist || "");

  const album = song.album || "";
  setText(albumEl, album);
  albumEl.classList.toggle("hidden", album === "");

  setArt(song.art);
  updateMediaSession(song);
}

async function refreshMetadata() {
  try {
    // The endpoint sends Cache-Control: max-age=10, which would otherwise let the
    // browser serve a stale copy back to a 10s poll.
    const res = await fetch(METADATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    stationOnline = data.is_online !== false;

    const song = data.now_playing && data.now_playing.song;
    if (song) render(song);

    refreshStatus();
  } catch (err) {
    // A failed poll is not fatal — keep the last known metadata and keep playing.
    console.warn("Now Playing fetch failed:", err);
  }
}

/* ---------- playback + recovery ---------- */

function refreshStatus() {
  let message = "";

  if (reconnectTimer) message = "Reconnecting…";
  else if (!navigator.onLine) message = "No connection";
  else if (!stationOnline) message = "Station offline";

  setText(statusEl, message);
  statusEl.classList.toggle("hidden", message === "");
}

function startPlayback() {
  wantsPlayback = true;
  if (!audio.src) audio.src = STREAM_URL;
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
  audio.src = STREAM_URL;
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
    if (stallCount >= (hasStarted ? STALL_LIMIT : STARTUP_LIMIT)) scheduleReconnect();
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
  setLabel();
  refreshStatus();
});
audio.addEventListener("waiting", () => setText(toggle, "Buffering…"));
audio.addEventListener("error", () => {
  console.warn("Stream error:", audio.error && audio.error.message);
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

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", startPlayback);
  navigator.mediaSession.setActionHandler("pause", stopPlayback);
  navigator.mediaSession.setActionHandler("stop", stopPlayback);
}

refreshMetadata();
setInterval(refreshMetadata, POLL_MS);
