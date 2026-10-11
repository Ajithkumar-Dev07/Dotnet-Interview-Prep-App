// Client-side search over the prebuilt inverted index (data/search.json).
// The index is built at deploy time, so the browser only does lookups:
// sorted term list + binary search gives fast prefix matching even for large content.

import { tokenize, normalize } from './tokenize.js';

let docs = [];
let head = null, body = null;
let headTerms = [], bodyTerms = [];

let bodyLoader = null;
let bodyPromise = null;

export function initSearch(data, loadBody) {
  docs = data.docs;
  head = data.head;
  headTerms = Object.keys(head).sort();
  bodyLoader = loadBody;
}

/** Loads the full-text index on demand. Resolves true when it was newly loaded. */
export function ensureBody() {
  if (body) return Promise.resolve(false);
  if (!bodyPromise) {
    bodyPromise = bodyLoader().then((b) => { body = b; bodyTerms = Object.keys(b).sort(); return true; })
      .catch((e) => { bodyPromise = null; throw e; });
  }
  return bodyPromise;
}
export const bodyReady = () => !!body;

export const allDocs = () => docs;

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Returns Map(docIdx -> score) for one query term against one field index. */
function lookup(term, terms, index, isLast) {
  const out = new Map();
  const add = (t, factor) => { for (const [d, w] of index[t]) out.set(d, Math.max(out.get(d) || 0, w * factor)); };
  if (index[term]) add(term, 1);
  // prefix expansion (always for the last word being typed, otherwise for words ≥ 3 chars)
  if (isLast || term.length >= 3) {
    let i = lowerBound(terms, term);
    let n = 0;
    for (; i < terms.length && terms[i].startsWith(term) && n < 300; i++, n++) {
      if (terms[i] !== term) add(terms[i], 0.55 + 0.35 * (term.length / terms[i].length));
    }
  }
  return out;
}

/**
 * @param {string} raw query text
 * @param {'head'|'all'} scope  'head' = question titles, headings, topics, tags; 'all' adds answers & code
 * @returns {{idx:number, score:number, doc:object}[]}
 */
export function search(raw, scope = 'all') {
  if (!head) return [];
  let qTerms = tokenize(raw);
  if (!qTerms.length) qTerms = tokenize(raw, true);
  if (!qTerms.length) return [];

  const per = qTerms.map((t, i) => {
    const last = i === qTerms.length - 1;
    const h = lookup(t, headTerms, head, last);
    if (scope === 'all' && body) {
      const b = lookup(t, bodyTerms, body, last);
      for (const [d, w] of b) h.set(d, (h.get(d) || 0) + w * 0.5);
    }
    return h;
  });

  const scores = new Map();
  const hits = new Map();
  per.forEach((m) => {
    for (const [d, w] of m) { scores.set(d, (scores.get(d) || 0) + w); hits.set(d, (hits.get(d) || 0) + 1); }
  });

  const phrase = normalize(raw).trim();
  let results = [];
  for (const [d, s] of scores) {
    const coverage = hits.get(d) / qTerms.length;
    let score = s * (coverage === 1 ? 1 : coverage * 0.35);
    if (phrase.length > 2 && normalize(docs[d].q).includes(phrase)) score += 25;
    results.push({ idx: d, score, full: coverage === 1, doc: docs[d] });
  }
  // prefer docs matching every word; fall back to partial matches only if needed
  const full = results.filter((r) => r.full);
  if (full.length) results = full;
  return results.sort((a, b) => b.score - a.score);
}

/** Wrap words in `text` that match any query term with <mark>. Text must be raw (unescaped). */
export function highlightText(text, raw, esc) {
  const q = tokenize(raw, true);
  if (!q.length) return esc(text);
  return String(text).split(/(\s+|[()[\],.?:;!"'`/])/).map((part) => {
    if (!part || /^\s+$/.test(part)) return part ? esc(part) : '';
    const t = tokenize(part, true);
    const hit = t.length && t.some((w) => q.some((x) => w.startsWith(x)));
    return hit ? `<mark>${esc(part)}</mark>` : esc(part);
  }).join('');
}
