#!/usr/bin/env node
// Build: content/*.md|*.json  →  dist/ (static site + generated data/*.json)
// Zero dependencies — needs only Node 18+.
//
//   node scripts/build.mjs            build into ./dist
//   node scripts/build.mjs --out dir  build into another folder

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, toPlain } from './lib/markdown.mjs';
import { highlight, langLabel } from './lib/highlight.mjs';
import { tokenize } from '../site/assets/js/tokenize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');
const SITE = path.join(ROOT, 'site');
const outArg = process.argv.indexOf('--out');
const DIST = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'dist');

const warnings = [];
const warn = (file, msg) => warnings.push(`  ⚠ ${file}: ${msg}`);

const PALETTE = ['#7c3aed', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#4f46e5', '#0d9488'];

export const slugify = (s) =>
  String(s).toLowerCase().replace(/c#/g, 'csharp').replace(/\.net/g, 'dotnet').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const titleFromSlug = (slug) =>
  slug.split('-').map((w) => (w.length <= 3 && /^(api|sql|dto|mvc|ef|oop|jwt|aws|csharp)$/.test(w)
    ? (w === 'csharp' ? 'C#' : w.toUpperCase())
    : w[0].toUpperCase() + w.slice(1))).join(' ');

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

const normDifficulty = (d) => {
  const v = String(d || '').trim().toLowerCase();
  if (!v) return '';
  if (v.startsWith('e') || v === 'beginner' || v === 'basic') return 'Easy';
  if (v.startsWith('m') || v === 'intermediate') return 'Medium';
  if (v.startsWith('h') || v === 'advanced' || v === 'expert') return 'Hard';
  return d;
};

// ------------------------------------------------------------------ parsers

function parseFrontMatter(text) {
  const m = text.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!m) return [{}, text];
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return [meta, text.slice(m[0].length)];
}

/** Pull fenced code blocks out of markdown → [markdownWithoutCode, codeBlocks[]] */
function extractCode(md) {
  const code = [];
  const lines = md.split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/);
    if (!f) { keep.push(lines[i]); continue; }
    const body = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith(f[1])) body.push(lines[i++]);
    const title = (f[3].match(/title\s*=\s*"([^"]*)"/) || [])[1] || '';
    code.push({ language: f[2] || 'text', title, code: body.join('\n').replace(/\s+$/, '') });
  }
  return [keep.join('\n'), code];
}

function parseMarkdownTopic(text, file) {
  const [meta, body] = parseFrontMatter(text);
  const sections = [];
  let section = null;
  let q = null;
  let inFence = false;
  let fenceMarker = '';
  let metaZone = false;

  const ensureSection = () => {
    if (!section) { section = { heading: 'General', questions: [] }; sections.push(section); }
    return section;
  };

  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const fm = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!inFence) { inFence = true; fenceMarker = fm[1]; }
      else if (raw.trim().startsWith(fenceMarker)) inFence = false;
    }
    if (!inFence && !fm) {
      const h2 = raw.match(/^##\s+(?!#)(.*)$/);
      if (h2) { section = { heading: h2[1].trim(), questions: [] }; sections.push(section); q = null; continue; }
      const h3 = raw.match(/^###\s+(?!#)(.*)$/);
      if (h3) {
        q = { question: h3[1].replace(/^Q\s*[:.)-]\s*/i, '').trim(), meta: {}, blocks: { pre: [] }, cur: 'pre' };
        ensureSection().questions.push(q);
        metaZone = true;
        continue;
      }
      if (q && metaZone) {
        const kv = raw.match(/^\s*(difficulty|level|tags|tag|related|id|order)\s*:\s*(.*)$/i);
        if (kv) { q.meta[kv[1].toLowerCase()] = kv[2].trim(); continue; }
        if (raw.trim()) metaZone = false;
      }
      const h4 = raw.match(/^####\s+(.*)$/);
      if (q && h4) {
        const name = h4[1].trim().toLowerCase();
        const key = name.startsWith('def') || name.startsWith('short') || name.startsWith('summary') ? 'definition'
          : name.startsWith('code') || name.startsWith('example') || name.startsWith('sample') ? 'code'
          : name.startsWith('answer') || name.startsWith('detail') || name.startsWith('explan') || name.startsWith('interview') ? 'answer'
          : null;
        if (key) { q.cur = key; q.blocks[key] = q.blocks[key] || []; metaZone = false; continue; }
      }
    }
    if (q) (q.blocks[q.cur] = q.blocks[q.cur] || []).push(raw);
    else if (raw.trim() && !inFence && !fm) {
      // stray text outside questions is ignored but reported
      if (!/^#\s/.test(raw)) warn(file, `text outside a question ignored: "${raw.trim().slice(0, 50)}"`);
    }
  }

  return {
    meta,
    sections: sections.map((s) => ({
      heading: s.heading,
      questions: s.questions.map((q) => {
        const join = (k) => (q.blocks[k] || []).join('\n').trim();
        let definition = join('definition');
        let answer = [join('pre'), join('answer')].filter(Boolean).join('\n\n');
        const code = [];
        let rest;
        [definition, rest] = extractCode(definition); code.push(...rest);
        [answer, rest] = extractCode(answer); code.push(...rest);
        const [, codeBlocks] = extractCode(join('code')); code.push(...codeBlocks);
        return {
          id: q.meta.id,
          question: q.question,
          difficulty: q.meta.difficulty || q.meta.level,
          tags: asList(q.meta.tags || q.meta.tag),
          related: asList(q.meta.related),
          definition: definition.trim(),
          answer: answer.trim(),
          code,
        };
      }),
    })),
  };
}

function parseJsonTopic(text, file) {
  if (!text.trim()) return { meta: {}, sections: [] };
  let data;
  try { data = JSON.parse(text); } catch (e) { warn(file, `invalid JSON (${e.message}) — topic shown as empty`); return { meta: {}, sections: [] }; }
  if (Array.isArray(data)) data = { sections: [{ heading: 'General', questions: data }] };
  const { sections = [], questions, ...meta } = data || {};
  const secs = Array.isArray(sections) ? [...sections] : [];
  if (Array.isArray(questions) && questions.length) secs.unshift({ heading: 'General', questions });
  const lower = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    meta: lower,
    sections: secs.map((s) => ({
      heading: s.heading || s.title || s.name || 'General',
      questions: (s.questions || []).map((q) => {
        let [definition, c1] = extractCode(String(q.definition || q.summary || ''));
        let [answer, c2] = extractCode(String(q.answer || q.details || ''));
        const code = (Array.isArray(q.code) ? q.code : q.code ? [q.code] : []).map((c) =>
          typeof c === 'string' ? { language: q.language || 'csharp', title: '', code: c } : { language: c.language || c.lang || 'text', title: c.title || '', code: String(c.code || '') });
        return {
          id: q.id,
          question: q.question || q.title || '',
          difficulty: q.difficulty || q.level,
          tags: asList(q.tags),
          related: asList(q.related),
          definition: definition.trim(),
          answer: answer.trim(),
          code: [...c1, ...c2, ...code],
        };
      }).filter((q) => q.question),
    })),
  };
}

// ------------------------------------------------------------------ load all topics

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('_') || d.name.startsWith('.')) return [];
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(md|markdown|json)$/i.test(d.name) && !/^readme\.md$/i.test(d.name) ? [p] : [];
  });
}

const files = walk(CONTENT).sort();
const topics = [];
const usedSlugs = new Set();

files.forEach((abs, idx) => {
  const rel = path.relative(CONTENT, abs).replace(/\\/g, '/');
  const base = path.basename(abs).replace(/\.(md|markdown|json)$/i, '');
  const prefix = base.match(/^(\d+)[-_. ]+/);
  let slug = slugify(base.replace(/^\d+[-_. ]+/, '')) || `topic-${idx + 1}`;
  while (usedSlugs.has(slug)) slug += '-2';
  usedSlugs.add(slug);

  const text = fs.readFileSync(abs, 'utf8');
  const parsed = /\.json$/i.test(abs) ? parseJsonTopic(text, rel) : parseMarkdownTopic(text, rel);
  const m = parsed.meta;

  const usedIds = new Set();
  const sections = parsed.sections
    .map((s, si) => {
      const sid = slugify(s.heading) || `section-${si + 1}`;
      return {
        id: sid,
        heading: s.heading,
        questions: s.questions.map((q) => {
          let id = slugify(q.id || q.question) || `q-${usedIds.size + 1}`;
          while (usedIds.has(id)) id += '-2';
          usedIds.add(id);
          if (!q.definition && !q.answer && !q.code.length) warn(rel, `"${q.question.slice(0, 50)}" has no content yet`);
          return { ...q, id, difficulty: normDifficulty(q.difficulty), tags: q.tags.map((t) => t.toLowerCase()) };
        }),
      };
    })
    .filter((s) => s.questions.length);

  topics.push({
    slug,
    file: rel,
    title: m.title || titleFromSlug(slug),
    description: m.description || '',
    icon: (m.icon || '').slice(0, 4) || (m.title || titleFromSlug(slug)).replace(/[^A-Za-z0-9#+]/g, '').slice(0, 3),
    color: /^#[0-9a-f]{3,8}$/i.test(m.color || '') ? m.color : PALETTE[idx % PALETTE.length],
    order: prefix ? +prefix[1] : m.order != null && m.order !== '' ? +m.order : 1000 + idx,
    sections,
  });
});

topics.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

// ------------------------------------------------------------------ related content (tags + TF-IDF cosine)

const allQ = [];
for (const t of topics) for (const s of t.sections) for (const q of s.questions) allQ.push({ t, s, q, key: `${t.slug}/${q.id}` });
const byKey = new Map(allQ.map((x) => [x.key, x]));

const df = new Map();
const vecs = allQ.map(({ t, s, q }) => {
  const v = new Map();
  const add = (term, w) => v.set(term, (v.get(term) || 0) + w);
  q.tags.forEach((tag) => add(`#${tag}`, 3));
  tokenize(q.question).forEach((w) => add(w, 2));
  tokenize(s.heading).forEach((w) => add(w, 1));
  tokenize(toPlain(q.definition)).forEach((w) => add(w, 0.5));
  for (const term of v.keys()) df.set(term, (df.get(term) || 0) + 1);
  return v;
});
const N = allQ.length || 1;
const norm = vecs.map((v) => {
  let sum = 0;
  for (const [term, w] of v) { const x = w * Math.log(1 + N / df.get(term)); v.set(term, x); sum += x * x; }
  return Math.sqrt(sum) || 1;
});

allQ.forEach((a, i) => {
  const explicit = a.q.related
    .map((r) => (r.includes('/') ? r : `${a.t.slug}/${r}`))
    .filter((r) => { if (!byKey.has(r)) { warn(a.t.file, `related "${r}" not found`); return false; } return r !== a.key; });
  const scores = [];
  allQ.forEach((b, j) => {
    if (i === j) return;
    let dot = 0;
    const [small, big] = vecs[i].size < vecs[j].size ? [vecs[i], vecs[j]] : [vecs[j], vecs[i]];
    for (const [term, w] of small) { const o = big.get(term); if (o) dot += w * o; }
    const score = dot / (norm[i] * norm[j]);
    if (score > 0.08) scores.push([b.key, score]);
  });
  scores.sort((x, y) => y[1] - x[1]);
  a.q.relatedKeys = [...new Set([...explicit, ...scores.slice(0, 8).map((x) => x[0])])].slice(0, 8);
});

// ------------------------------------------------------------------ search index

const docs = [];
const headIdx = new Map();
const bodyIdx = new Map();
const post = (idx, term, doc, w) => {
  let m = idx.get(term);
  if (!m) idx.set(term, (m = new Map()));
  m.set(doc, (m.get(doc) || 0) + w);
};

allQ.forEach(({ t, s, q, key }, d) => {
  const def = toPlain(q.definition);
  docs.push({
    k: key, t: t.slug, s: s.id, q: q.question, d: q.difficulty, g: q.tags,
    x: (def || toPlain(q.answer)).slice(0, 180),
    r: q.relatedKeys,
  });
  tokenize(q.question).forEach((w) => post(headIdx, w, d, 10));
  tokenize(s.heading).forEach((w) => post(headIdx, w, d, 4));
  tokenize(t.title).forEach((w) => post(headIdx, w, d, 2));
  q.tags.forEach((tag) => tokenize(tag).forEach((w) => post(headIdx, w, d, 5)));
  tokenize(def).forEach((w) => post(bodyIdx, w, d, 2));
  tokenize(toPlain(q.answer)).forEach((w) => post(bodyIdx, w, d, 1));
  q.code.forEach((c) => { tokenize(c.title).forEach((w) => post(bodyIdx, w, d, 2)); tokenize(c.code).forEach((w) => post(bodyIdx, w, d, 0.3)); });
});

const pack = (idx) => {
  const o = {};
  for (const term of [...idx.keys()].sort()) {
    o[term] = [...idx.get(term)].map(([doc, w]) => [doc, Math.round(Math.min(w, 40) * 10) / 10]);
  }
  return o;
};

// ------------------------------------------------------------------ write output

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SITE, DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'data', 'topics'), { recursive: true });
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const write = (rel, obj) => fs.writeFileSync(path.join(DIST, 'data', rel), JSON.stringify(obj));
const version = Date.now().toString(36);

const tagCount = new Map();
allQ.forEach(({ q }) => q.tags.forEach((tag) => tagCount.set(tag, (tagCount.get(tag) || 0) + 1)));

write('manifest.json', {
  version,
  generatedAt: new Date().toISOString(),
  totals: { topics: topics.length, questions: allQ.length },
  tags: [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count })),
  topics: topics.map((t) => ({
    slug: t.slug, title: t.title, description: t.description, icon: t.icon, color: t.color, file: t.file,
    count: t.sections.reduce((n, s) => n + s.questions.length, 0),
    sections: t.sections.map((s) => ({ id: s.id, heading: s.heading, questions: s.questions.map((q) => q.id) })),
  })),
});

// head index (titles, headings, topics, tags) is loaded up-front; the bigger full-text
// index is fetched lazily the first time someone searches in "Full text" mode.
write('search.json', { docs, head: pack(headIdx) });
write('search-body.json', pack(bodyIdx));

for (const t of topics) {
  write(`topics/${t.slug}.json`, {
    slug: t.slug,
    sections: t.sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      questions: s.questions.map((q) => ({
        id: q.id,
        question: q.question,
        difficulty: q.difficulty,
        tags: q.tags,
        related: q.relatedKeys,
        definition: renderMarkdown(q.definition),
        answer: renderMarkdown(q.answer),
        code: q.code.map((c) => ({ language: c.language, label: langLabel(c.language), title: c.title, code: c.code, html: highlight(c.code, c.language) })),
      })),
    })),
  });
}

// cache-bust the data folder for this deploy
const indexPath = path.join(DIST, 'index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace(/__BUILD_VERSION__/g, version));

const kb = (f) => (fs.statSync(path.join(DIST, 'data', f)).size / 1024).toFixed(1);
console.log(`✔ Built ${topics.length} topics, ${allQ.length} questions → ${path.relative(ROOT, DIST) || DIST}`);
console.log(`  manifest ${kb('manifest.json')} KB · search ${kb('search.json')} KB · full-text ${kb('search-body.json')} KB (lazy)`);
for (const t of topics) console.log(`  • ${t.title.padEnd(26)} ${String(t.sections.reduce((n, s) => n + s.questions.length, 0)).padStart(3)} Q  (${t.file})`);
if (warnings.length) { console.log(`\n${warnings.length} warning(s):`); console.log(warnings.join('\n')); }
