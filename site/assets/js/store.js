// Small persistence layer (bookmarks, preferences) over localStorage.
// Every access is guarded: private windows / blocked storage just fall back to memory.

const PREFIX = 'dip.';
const mem = {};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? (key in mem ? mem[key] : fallback) : JSON.parse(v);
  } catch { return key in mem ? mem[key] : fallback; }
}
function write(key, value) {
  mem[key] = value;
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* memory only */ }
}

const listeners = new Set();
let bookmarks = new Map(Object.entries(read('bookmarks', {}))); // key -> savedAt

export const store = {
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  isBookmarked: (key) => bookmarks.has(key),
  bookmarkKeys: () => [...bookmarks.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
  bookmarkCount: () => bookmarks.size,
  toggleBookmark(key) {
    if (bookmarks.has(key)) bookmarks.delete(key); else bookmarks.set(key, Date.now());
    write('bookmarks', Object.fromEntries(bookmarks));
    listeners.forEach((fn) => fn('bookmarks'));
    return bookmarks.has(key);
  },
  exportBookmarks: () => JSON.stringify({ app: 'dotnet-interview-prep', bookmarks: Object.fromEntries(bookmarks) }, null, 2),
  importBookmarks(json) {
    const data = JSON.parse(json);
    const incoming = data.bookmarks || data;
    for (const [k, v] of Object.entries(incoming)) if (typeof k === 'string' && k.includes('/')) bookmarks.set(k, +v || Date.now());
    write('bookmarks', Object.fromEntries(bookmarks));
    listeners.forEach((fn) => fn('bookmarks'));
  },

  pref: (name, fallback) => read('pref.' + name, fallback),
  setPref: (name, value) => write('pref.' + name, value),

  theme() { try { return localStorage.getItem(PREFIX + 'theme'); } catch { return null; } },
  setTheme(t) { try { localStorage.setItem(PREFIX + 'theme', t); } catch { /* ignore */ } },
};
