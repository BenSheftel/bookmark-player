'use strict';

/* ============================================================
   Helpers
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const stripExt = n => n.replace(/\.[^./\\]+$/, '');
const icon = name => `<svg class="ic"><use href="#i-${name}"/></svg>`;

function fmt(t, precise = false) {
  if (!isFinite(t) || t < 0) t = 0;
  t = precise ? Math.round(t * 10) / 10 : Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t - Math.floor(t / 60) * 60;
  const s = precise ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "83", "1:23", "1:23.5", "1:02:03" -> seconds, or null if invalid */
function parseTime(str) {
  const s = String(str).trim().replace(',', '.');
  if (!/^\d+(?:\.\d*)?$|^\d+(?::\d{1,2}){1,2}(?:\.\d*)?$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.slice(1).some(p => p >= 60)) return null;
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 10) / 10;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ============================================================
   Storage (IndexedDB): songs (metadata), files (Blob), bookmarks
   ============================================================ */
let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('bookmark-player', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('songs', { keyPath: 'id' });
      d.createObjectStore('files');
      d.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('songId', 'songId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = async (name, mode = 'readonly') => (await db()).transaction(name, mode).objectStore(name);
const dbGetAll = async name => req((await store(name)).getAll());
const dbGet = async (name, key) => req((await store(name)).get(key));
const dbPut = async (name, val, key) => req((await store(name, 'readwrite')).put(val, key));
const dbDel = async (name, key) => req((await store(name, 'readwrite')).delete(key));
const bookmarksFor = async songId => req((await store('bookmarks')).index('songId').getAll(songId));

/* Last-played song + position, so the app reopens where you left off */
const LAST_KEY = 'bp:last';
function saveLast(time) {
  if (!current) return;
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ songId: current.id, time })); } catch {}
}
function readLast() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY)); } catch { return null; }
}

/* ============================================================
   State
   ============================================================ */
const audio = $('#audio');
const seek = $('#seek');
let songs = [];          // sorted song metadata
let current = null;      // currently loaded song metadata
let currentUrl = null;   // object URL for current song
let bookmarks = [];      // bookmarks of current song, sorted by time
let pendingSeek = null;  // seek requested before metadata was loaded
let dragging = false;    // user is dragging the seek bar
let editing = null;      // bookmark being edited

const knownDuration = () => (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (current?.duration || 0);
const currentPos = () => pendingSeek ?? audio.currentTime ?? 0;

/* ============================================================
   Views + Android back button (via history)
   ============================================================ */
// Chrome's back button skips history entries a page adds before the user has touched it,
// so when the app opens straight into the player we add the entry on the first tap instead.
let userActivated = false, pendingPlayerEntry = false;
const pushPlayerEntry = () => { if (location.hash !== '#player') history.pushState(null, '', '#player'); };
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => {
    userActivated = true;
    if (pendingPlayerEntry) {
      pendingPlayerEntry = false;
      if ($('#view-player').classList.contains('active')) pushPlayerEntry();
    }
  }, { capture: true });
}

function showView(name, push = true) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  if (push && name === 'player') {
    if (userActivated) pushPlayerEntry(); else pendingPlayerEntry = true;
  }
  if (name !== 'player') pendingPlayerEntry = false;
  if (name === 'library') refreshLibrary();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if (!started) return;
  if ($('#bm-dialog').open) {             // Back closes the edit box, not the song
    $('#bm-dialog').close();
    if ($('#view-player').classList.contains('active')) pushPlayerEntry();
    return;
  }
  showView(location.hash === '#player' && current ? 'player' : 'library', false);
});
$('#back-btn').onclick = () => {
  if (location.hash === '#player') history.back(); else showView('library', false);
};

/* ============================================================
   Library
   ============================================================ */
async function refreshLibrary() {
  songs = (await dbGetAll('songs')).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const counts = {};
  for (const b of await dbGetAll('bookmarks')) counts[b.songId] = (counts[b.songId] || 0) + 1;

  const ul = $('#song-list');
  ul.textContent = '';
  $('#empty-library').hidden = songs.length > 0;
  for (const s of songs) {
    const li = document.createElement('li');
    li.className = 'row' + (current?.id === s.id ? ' playing' : '');
    li.innerHTML = '<button class="row-main"><span class="row-title"></span><span class="row-sub"></span></button>' +
                   `<button class="btn icon danger" aria-label="Remove song">${icon('x')}</button>`;
    $('.row-title', li).textContent = s.name;
    const n = counts[s.id] || 0;
    $('.row-sub', li).textContent =
      [s.duration ? fmt(s.duration) : null, `${n} bookmark${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    $('.row-main', li).onclick = () => openSong(s);
    li.lastElementChild.onclick = () => removeSong(s);
    ul.append(li);
  }
  updateMini();
}

async function saveFile(file, id) {
  try { await dbPut('files', file, id); }
  catch {
    // Some WebViews refuse to store File objects directly; store a plain Blob copy instead.
    await dbPut('files', new Blob([await file.arrayBuffer()], { type: file.type }), id);
  }
}

$('#file-input').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  toast(`Adding ${files.length} song${files.length === 1 ? '' : 's'}…`);
  let added = 0, skipped = 0, failed = 0, firstNew = null;
  for (const f of files) {
    const name = stripExt(f.name);
    if (songs.some(s => s.name === name && s.size === f.size)) { skipped++; continue; }
    const song = { id: uid(), name, fileName: f.name, type: f.type, size: f.size, addedAt: Date.now(), duration: 0 };
    try {
      await saveFile(f, song.id);
      await dbPut('songs', song);
      songs.push(song);
      firstNew ||= song;
      added++;
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  await refreshLibrary();
  const msg = [added && `Added ${added}`, skipped && `${skipped} already in library`, failed && `${failed} failed (storage full?)`]
    .filter(Boolean).join(' · ');
  toast(msg || 'Nothing added');
  if (added === 1 && files.length === 1) openSong(songs.find(s => s.id === firstNew.id));
});

async function removeSong(s) {
  if (!confirm(`Remove “${s.name}” and all its bookmarks from the app?\n\n(The original file on your device is not touched.)`)) return;
  if (current?.id === s.id) unloadCurrent();
  for (const b of await bookmarksFor(s.id)) await dbDel('bookmarks', b.id);
  await dbDel('files', s.id);
  await dbDel('songs', s.id);
  await refreshLibrary();
  toast('Song removed');
}

function unloadCurrent() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  current = currentUrl = null;
  bookmarks = [];
  pendingSeek = null;
  try { localStorage.removeItem(LAST_KEY); } catch {}
  updateMini();
}

/* ============================================================
   Player
   ============================================================ */
async function openSong(s, { at = 0, show = true } = {}) {
  if (current?.id !== s.id) {
    const blob = await dbGet('files', s.id);
    if (!blob) { alert('The audio for this song is missing from storage. Remove it and add it again.'); return; }
    audio.pause();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(blob);
    current = s;
    pendingSeek = at || null;
    audio.src = currentUrl;
    audio.load();
    $('#song-title').textContent = s.name;
    saveLast(at || 0);
    setMediaMetadata();
    updateTimeUI(at || 0);
    updatePlayButton();
  }
  await loadBookmarks();
  if (show) showView('player');
  updateMini();
}

function seekTo(t) {
  if (!current) return;
  const dur = knownDuration();
  t = Math.max(0, dur ? Math.min(t, dur) : t);
  if (audio.readyState >= 1 && isFinite(audio.duration)) {
    audio.currentTime = t;
    pendingSeek = null;
  } else {
    pendingSeek = t;      // applied when metadata loads (e.g. iOS before first play)
  }
  updateTimeUI(t);
  saveLast(t);
}
const skip = d => seekTo(currentPos() + d);

async function step(dir) {
  if (!current) return;
  if (dir < 0 && currentPos() > 3) { seekTo(0); return; }
  const i = songs.findIndex(s => s.id === current.id);
  const n = songs[i + dir];
  if (!n) { if (dir < 0) seekTo(0); return; }
  const wasPlaying = !audio.paused;
  await openSong(n, { show: $('#view-player').classList.contains('active') });
  if (wasPlaying) audio.play().catch(() => {});
}

function togglePlay() {
  if (!current) return;
  if (audio.paused) audio.play().catch(err => { console.warn(err); toast('Could not play this file'); });
  else audio.pause();
}

$('#play').onclick = togglePlay;
$('#back10').onclick = () => skip(-10);
$('#fwd10').onclick = () => skip(10);
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);

seek.addEventListener('input', () => {
  dragging = true;
  $('#t-cur').textContent = fmt(+seek.value);
  setFill(+seek.value);
});
seek.addEventListener('change', () => { dragging = false; seekTo(+seek.value); });

function setFill(t) {
  const d = knownDuration();
  seek.style.setProperty('--p', d ? (t / d * 100) + '%' : '0%');
}

function updateTimeUI(t = currentPos()) {
  const d = knownDuration();
  $('#t-cur').textContent = fmt(t);
  $('#t-dur').textContent = fmt(d);
  seek.max = d || 0;
  if (!dragging) { seek.value = t; setFill(t); }
  $('#mini-time').textContent = `${fmt(t)} / ${fmt(d)}`;
}

function updatePlayButton() {
  const playing = !audio.paused;
  $('#play').innerHTML = icon(playing ? 'pause' : 'play');
  $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#mini-state').innerHTML = icon(playing ? 'pause' : 'play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  if (pendingSeek != null) return;
  updateTimeUI();
  if (Date.now() - lastSaved > 2000) { lastSaved = Date.now(); saveLast(audio.currentTime); updatePositionState(); }
});
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) {
    audio.currentTime = clamp(pendingSeek, 0, audio.duration || pendingSeek);
    pendingSeek = null;
  }
  if (current && isFinite(audio.duration) && Math.abs((current.duration || 0) - audio.duration) > 0.5) {
    current.duration = audio.duration;
    dbPut('songs', current).catch(() => {});
  }
  updateTimeUI();
  renderTicks();
  updatePositionState();
});
audio.addEventListener('play', updatePlayButton);
audio.addEventListener('pause', () => { updatePlayButton(); saveLast(currentPos()); });
audio.addEventListener('ended', updatePlayButton);
audio.addEventListener('error', () => { if (current) toast('This file format may not be supported on this device'); });

/* ============================================================
   Bookmarks (CRUD)
   ============================================================ */
async function loadBookmarks() {
  bookmarks = current ? (await bookmarksFor(current.id)).sort((a, b) => a.time - b.time) : [];
  renderBookmarks();
  renderTicks();
}

function renderBookmarks(flashId) {
  const ul = $('#bm-list');
  ul.textContent = '';
  $('#bm-empty').hidden = bookmarks.length > 0;
  for (const b of bookmarks) {
    const li = document.createElement('li');
    li.className = 'row' + (b.id === flashId ? ' flash' : '');
    li.innerHTML = '<button class="bm-jump"><span class="bm-time"></span><span class="bm-label"></span></button>' +
                   `<button class="btn icon" aria-label="Edit bookmark">${icon('edit')}</button>` +
                   `<button class="btn icon danger" aria-label="Delete bookmark">${icon('x')}</button>`;
    $('.bm-time', li).textContent = fmt(b.time, true);
    $('.bm-label', li).textContent = b.label;
    $('.bm-jump', li).onclick = () => {
      seekTo(b.time);
      li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
      if (audio.paused) toast(`Playhead at ${fmt(b.time, true)}. Press play to start`);
    };
    li.children[1].onclick = () => openEditor(b);
    li.children[2].onclick = () => deleteBookmark(b);
    ul.append(li);
  }
}

function renderTicks() {
  const el = $('#ticks');
  el.textContent = '';
  const d = knownDuration();
  if (!d) return;
  for (const b of bookmarks) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.left = clamp(b.time / d * 100, 0, 100) + '%';
    el.append(t);
  }
}

$('#add-bm').onclick = async () => {
  if (!current) return;
  const time = Math.round(currentPos() * 10) / 10;
  let n = bookmarks.length + 1;
  while (bookmarks.some(b => b.label === `Bookmark ${n}`)) n++;
  const b = { id: uid(), songId: current.id, time, label: `Bookmark ${n}`, createdAt: Date.now() };
  await dbPut('bookmarks', b);
  await loadBookmarks();
  renderBookmarks(b.id);
  toast(`Bookmarked ${fmt(time, true)}. Tap the pencil to rename`);
};

async function deleteBookmark(b) {
  if (!confirm(`Delete bookmark “${b.label}” at ${fmt(b.time, true)}?`)) return;
  await dbDel('bookmarks', b.id);
  await loadBookmarks();
  toast('Bookmark deleted');
}

const dlg = $('#bm-dialog');
function openEditor(b) {
  editing = b;
  $('#bm-label').value = b.label;
  $('#bm-time').value = fmt(b.time, true);
  $('#bm-error').hidden = true;
  dlg.showModal();
}
for (const btn of dlg.querySelectorAll('[data-nudge]')) {
  btn.onclick = () => {
    const t = parseTime($('#bm-time').value) ?? editing.time;
    const d = knownDuration();
    $('#bm-time').value = fmt(clamp(t + Number(btn.dataset.nudge), 0, d || Infinity), true);
  };
}
$('#bm-now').onclick = () => { $('#bm-time').value = fmt(currentPos(), true); };
$('#bm-cancel').onclick = () => dlg.close();
async function saveEditor() {
  const t = parseTime($('#bm-time').value);
  const d = knownDuration();
  const err = $('#bm-error');
  if (t == null) { err.textContent = 'Enter a position like 1:23 or 1:23.5'; err.hidden = false; return; }
  if (d && t > d + 0.05) { err.textContent = `Position is past the end of the song (${fmt(d, true)})`; err.hidden = false; return; }
  editing.time = t;
  editing.label = $('#bm-label').value.trim() || `Bookmark at ${fmt(t, true)}`;
  await dbPut('bookmarks', editing);
  dlg.close();
  const id = editing.id;
  await loadBookmarks();
  renderBookmarks(id);
}
$('#bm-save').onclick = saveEditor;
for (const inp of [$('#bm-label'), $('#bm-time')]) {
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveEditor(); } });
}

/* ============================================================
   Bookmark packs: export / import a song's bookmarks as a .json file
   ============================================================ */
const PACK_FORMAT = 'bookmark-player-pack';
const safeName = s => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'song';

$('#export-bm').onclick = async () => {
  if (!current) return;
  if (!bookmarks.length) { toast('No bookmarks to export yet'); return; }
  const pack = {
    format: PACK_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    song: { name: current.name, fileName: current.fileName, duration: Math.round(knownDuration() * 10) / 10 },
    bookmarks: bookmarks.map(b => ({ time: b.time, label: b.label })),
  };
  const fileName = `${safeName(current.name)} - bookmarks.json`;
  const file = new File([JSON.stringify(pack, null, 2)], fileName, { type: 'application/json' });
  // Share sheet where the platform allows it (iPhone: Save to Files, AirDrop, Messages...)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fileName }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  // Otherwise a normal download (Android: Downloads folder)
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  toast(`Saved “${fileName}”`);
};

$('#import-input').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !current) return;
  let pack;
  try { pack = JSON.parse(await f.text()); } catch { pack = null; }
  if (pack?.format !== PACK_FORMAT || !Array.isArray(pack.bookmarks)) {
    alert('That file isn’t a bookmark pack. Pick a “… - bookmarks.json” file exported from this app.');
    return;
  }
  if (pack.song?.name && pack.song.name !== current.name &&
      !confirm(`This pack was made for “${pack.song.name}”.\n\nImport its ${pack.bookmarks.length} bookmark(s) into “${current.name}” anyway?`)) return;

  const dur = knownDuration();
  let added = 0, dupes = 0, outOfRange = 0;
  for (const raw of pack.bookmarks) {
    let t = typeof raw?.time === 'string' ? parseTime(raw.time) : Number(raw?.time);
    if (t == null || !isFinite(t) || t < 0 || (dur && t > dur + 0.05)) { outOfRange++; continue; }
    t = Math.round(t * 10) / 10;
    const label = String(raw.label ?? '').trim().slice(0, 80) || `Bookmark at ${fmt(t, true)}`;
    if (bookmarks.some(b => Math.abs(b.time - t) < 0.05 && b.label === label)) { dupes++; continue; }
    const b = { id: uid(), songId: current.id, time: t, label, createdAt: Date.now() };
    await dbPut('bookmarks', b);
    bookmarks.push(b);
    added++;
  }
  await loadBookmarks();
  toast([`Imported ${added} bookmark${added === 1 ? '' : 's'}`,
         dupes && `${dupes} already here`, outOfRange && `${outOfRange} skipped (outside this song’s length)`]
    .filter(Boolean).join(' · '));
});

/* ============================================================
   Mini player (library screen)
   ============================================================ */
function updateMini() {
  const mini = $('#mini');
  mini.hidden = !current;
  if (current) $('#mini-title').textContent = current.name;
}
$('#mini').onclick = e => {
  if (e.target.closest('#mini-state')) { togglePlay(); return; }
  showView('player');
};

/* ============================================================
   Lock-screen / notification controls (Media Session)
   ============================================================ */
function setMediaMetadata() {
  if (!('mediaSession' in navigator) || !current) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.name, artist: 'Bookmark Player',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}
function updatePositionState() {
  const d = knownDuration();
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !d) return;
  try { navigator.mediaSession.setPositionState({ duration: d, position: clamp(audio.currentTime, 0, d), playbackRate: audio.playbackRate || 1 }); } catch {}
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => audio.play(), pause: () => audio.pause(),
    seekbackward: () => skip(-10), seekforward: () => skip(10),
    previoustrack: () => step(-1), nexttrack: () => step(1),
    seekto: d => seekTo(d.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

/* ============================================================
   Startup
   ============================================================ */
function registerServiceWorker() {
  // Native (APK) build serves files locally; the service worker is only for the PWA/iOS build.
  if (window.Capacitor || !('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed', err));
}

/* ---------- Install gate: the player only runs as an installed app ---------- */
let deferredInstall = null;   // Chrome/Edge/Samsung one-tap install prompt
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('#install-btn').hidden = false;
});
window.addEventListener('appinstalled', () => {
  $('#install-btn').hidden = true;
  $('#install-steps').innerHTML = '<li class="done">Installed! Open <b>Bookmarks</b> from your home screen.</li>';
});

function isInstalled() {
  if (window.Capacitor) return true;                       // Android APK build
  if (navigator.standalone === true) return true;          // iOS home-screen app
  return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
    .some(m => matchMedia(`(display-mode: ${m})`).matches);
}

function detectPlatform() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|Snapchat|TikTok|musical_ly|BytedanceWebview|Pinterest|LinkedInApp|GSA\//.test(ua)
    || (android && /; wv\)/.test(ua));
  let browser = 'other';
  if (ios) browser = /CriOS/.test(ua) ? 'chrome' : /FxiOS/.test(ua) ? 'firefox' : /EdgiOS/.test(ua) ? 'edge' : /Safari/.test(ua) ? 'safari' : 'other';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/Firefox\//.test(ua)) browser = 'firefox';
  else if (/EdgA?\//.test(ua)) browser = 'edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'opera';
  else if (/Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua)) browser = 'safari';
  return { os: ios ? 'ios' : android ? 'android' : 'desktop', browser, inApp };
}

function installSteps({ os, browser, inApp }) {
  const share = icon('share'), dots = icon('dots');
  const openApp = 'Open <b>Bookmarks</b> from your home screen. That’s the app; this browser tab isn’t needed after.';
  if (inApp) return {
    steps: [os === 'ios'
      ? 'This page is open inside another app. Tap the <b>···</b> or share menu and choose <b>Open in Safari</b> (or Open in browser).'
      : `This page is open inside another app. Tap the ${dots} menu and choose <b>Open in Chrome</b> (or Open in browser).`,
      'Follow the install steps shown there.'],
    note: 'Or copy the link below and paste it into your browser.', link: true,
  };
  if (os === 'ios') {
    if (browser === 'safari') return { steps: [
      `Tap the <b>Share</b> button ${share}. It’s in the toolbar, or inside the <b>···</b> menu on newer iPhones.`,
      'Scroll down and tap <b>Add to Home Screen</b>.',
      'Keep <b>Open as Web App</b> switched on, then tap <b>Add</b>.', openApp] };
    return { steps: [
      `Tap the <b>Share</b> button ${share} in the address bar${browser === 'firefox' ? ' (or in the menu)' : ''}.`,
      'Tap <b>Add to Home Screen</b>, then <b>Add</b>.', openApp],
      note: 'Don’t see “Add to Home Screen”? Open this page in Safari and do it from there.', link: true };
  }
  if (os === 'android') {
    const steps = {
      chrome: [`Tap the ${dots} menu at the top right.`, 'Tap <b>Add to Home screen</b> (or <b>Install app</b>), then <b>Install</b>.'],
      edge: ['Tap the <b>···</b> menu at the bottom.', 'Tap <b>Add to phone</b>, then <b>Install</b>.'],
      samsung: ['Tap the <b>☰</b> menu at the bottom right.', 'Tap <b>Add page to</b>, then <b>Home screen</b>.'],
      firefox: [`Tap the ${dots} menu.`, 'Tap <b>Add app to Home screen</b> (or <b>Add to Home screen</b>), then <b>Add</b>.'],
      opera: [`Tap the ${dots} menu.`, 'Tap <b>Add to</b>, then <b>Home screen</b>.'],
    }[browser] || [`Open your browser’s ${dots} menu.`, 'Choose <b>Add to Home screen</b> or <b>Install app</b>.'];
    return { steps: [...steps, openApp],
      note: browser === 'other' ? 'Works best in Chrome. If you can’t find the option, open this page in Chrome.' : '' };
  }
  return {
    steps: ['This app is made for your phone. Open this page on your iPhone or Android phone and follow the steps there.',
      'On a computer, Chrome and Edge can also install it from the install icon at the right of the address bar.'],
    link: true };
}

function showInstallGate() {
  const info = installSteps(detectPlatform());
  $('#install-steps').innerHTML = info.steps.map(s => `<li>${s}</li>`).join('');
  $('#install-note').hidden = !info.note;
  $('#install-note').textContent = info.note || '';
  $('#install-link').hidden = !info.link;
  $('#install-url').textContent = location.origin + location.pathname;
  $('#install-btn').hidden = !deferredInstall;
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-install');
}
$('#install-btn').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
};
$('#copy-url').onclick = async () => {
  try { await navigator.clipboard.writeText($('#install-url').textContent); toast('Link copied'); }
  catch { toast('Press and hold the link to copy it'); }
};
$('#install-skip').onclick = () => {
  try { localStorage.setItem('bp:skipGate', '1'); } catch {}
  startApp();
};

/* ---------- App start ---------- */
let started = false;
async function startApp() {
  if (started) return;
  started = true;
  showView('library', false);
  try { await navigator.storage?.persist?.(); } catch {}
  setupMediaSession();
  await refreshLibrary();
  const last = readLast();
  const s = last && songs.find(x => x.id === last.songId);
  if (s) await openSong(s, { at: last.time || 0 });
}

(() => {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const devBypass = isLocal && new URLSearchParams(location.search).has('app');   // local testing only
  let skipped = false;
  try { skipped = localStorage.getItem('bp:skipGate') === '1'; } catch {}
  registerServiceWorker();   // cache the app for offline use, even from the install page
  if (isInstalled() || devBypass || skipped) startApp().catch(err => { console.error(err); alert('Startup error: ' + err.message); });
  else showInstallGate();
})();
