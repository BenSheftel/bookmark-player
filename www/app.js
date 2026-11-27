'use strict';

/* ============================================================
   Helpers
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const stripExt = n => n.replace(/\.[^./\\]+$/, '');

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
function showView(name, push = true) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  if (push && name === 'player' && location.hash !== '#player') history.pushState(null, '', '#player');
  if (name === 'library') refreshLibrary();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if ($('#bm-dialog').open) $('#bm-dialog').close();
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
                   '<button class="btn icon danger" aria-label="Remove song">✕</button>';
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
  $('#play').textContent = playing ? '❚❚' : '▶';
  $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#mini-state').textContent = playing ? '❚❚' : '▶';
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
                   '<button class="btn icon" aria-label="Edit bookmark">✎</button>' +
                   '<button class="btn icon danger" aria-label="Delete bookmark">✕</button>';
    $('.bm-time', li).textContent = fmt(b.time, true);
    $('.bm-label', li).textContent = b.label;
    $('.bm-jump', li).onclick = () => {
      seekTo(b.time);
      li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
      if (audio.paused) toast(`Playhead at ${fmt(b.time, true)} — press ▶ to play`);
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
  toast(`Bookmarked ${fmt(time, true)} — tap ✎ to rename`);
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

(async () => {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  try { await navigator.storage?.persist?.(); } catch {}
  setupMediaSession();
  await refreshLibrary();
  const last = readLast();
  const s = last && songs.find(x => x.id === last.songId);
  if (s) await openSong(s, { at: last.time || 0 });
  registerServiceWorker();
})().catch(err => { console.error(err); alert('Startup error: ' + err.message); });
