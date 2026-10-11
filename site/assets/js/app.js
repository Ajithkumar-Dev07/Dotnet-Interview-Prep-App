// .NET Interview Prep — front-end only, read-only app.
// Data comes from data/*.json, generated at build time from the content/ folder.

import { initSearch, search, allDocs, highlightText, ensureBody, bodyReady } from './search.js';
import { store } from './store.js';

const V = window.__BUILD__ && !window.__BUILD__.startsWith('__') ? window.__BUILD__ : String(Date.now());
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const DIFFS = ['Easy', 'Medium', 'Hard'];
const PAGE = 60;

const state = {
  manifest: null,
  topicBySlug: new Map(),
  sectionTitle: new Map(), // "topic/section" -> heading
  docByKey: new Map(),
  topicCache: new Map(), // slug -> Promise<topic json>
  expanded: new Set(),
  sidebarOpen: new Set(),
  openPop: null,
  shown: PAGE,
  lastListSig: '',
  scope: store.pref('scope', 'head'),
};

// ------------------------------------------------------------------ data

async function getJSON(url) {
  const res = await fetch(`${url}?v=${V}`);
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return res.json();
}

function loadTopic(slug) {
  if (!state.topicCache.has(slug)) {
    const p = getJSON(`data/topics/${slug}.json`).then((t) => {
      t.byId = new Map();
      for (const s of t.sections) for (const q of s.questions) t.byId.set(q.id, { ...q, sectionId: s.id, heading: s.heading });
      return t;
    });
    p.catch(() => state.topicCache.delete(slug));
    state.topicCache.set(slug, p);
  }
  return state.topicCache.get(slug);
}

async function loadQuestion(key) {
  const [slug, id] = key.split('/');
  const t = await loadTopic(slug);
  return t.byId.get(id);
}

// ------------------------------------------------------------------ routing

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const p = new URLSearchParams(qs);
  const list = (k) => (p.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    view: parts[0] || 'home',
    parts,
    params: p,
    filters: {
      q: p.get('q') || '',
      scope: p.get('scope') || state.scope,
      topics: list('topics'),
      diff: list('diff'),
      tags: list('tags'),
      bm: p.get('bm') === '1',
      rel: p.get('rel') || '',
    },
  };
}

function filtersToQuery(f, { omitTopics = false } = {}) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.q && f.scope && f.scope !== 'head') p.set('scope', f.scope);
  if (!omitTopics && f.topics?.length) p.set('topics', f.topics.join(','));
  if (f.diff?.length) p.set('diff', f.diff.join(','));
  if (f.tags?.length) p.set('tags', f.tags.join(','));
  if (f.bm) p.set('bm', '1');
  if (f.rel) p.set('rel', f.rel);
  const s = p.toString().replace(/%2C/g, ',').replace(/%2F/g, '/');
  return s ? `?${s}` : '';
}

/** Build the hash for a list view with the given filters (keeps topic pages on their own route). */
function listHash(f, route = parseHash()) {
  if (route.view === 'topic' && route.parts[1] && (!f.topics.length || (f.topics.length === 1 && f.topics[0] === route.parts[1])) && !f.q && !f.rel) {
    return `#/topic/${route.parts[1]}${filtersToQuery(f, { omitTopics: true })}`;
  }
  if (route.view === 'bookmarks' && f.bm && !f.q && !f.rel && !f.topics.length) {
    return `#/bookmarks${filtersToQuery({ ...f, bm: false })}`;
  }
  return `#/browse${filtersToQuery(f)}`;
}

function currentFilters(route = parseHash()) {
  const f = { ...route.filters };
  if (route.view === 'topic' && route.parts[1]) f.topics = [route.parts[1]];
  if (route.view === 'bookmarks') f.bm = true;
  return f;
}

function go(hash, { replace = false } = {}) {
  if (replace) { history.replaceState(null, '', hash); render(); }
  else if (location.hash === hash) render();
  else location.hash = hash;
}

// ------------------------------------------------------------------ filtering

function filterDocs(f) {
  let list;
  let ranked = false;
  if (f.q.trim()) { list = search(f.q, f.scope).map((r) => r.doc); ranked = true; }
  else list = allDocs();

  if (f.rel) {
    const src = state.docByKey.get(f.rel);
    const relKeys = src ? src.r : [];
    if (ranked) { const set = new Set(relKeys); list = list.filter((d) => set.has(d.k)); }
    else { list = relKeys.map((k) => state.docByKey.get(k)).filter(Boolean); ranked = true; }
  }
  if (f.topics.length) { const s = new Set(f.topics); list = list.filter((d) => s.has(d.t)); }
  if (f.diff.length) { const s = new Set(f.diff); list = list.filter((d) => s.has(d.d)); }
  if (f.tags.length) { const s = new Set(f.tags); list = list.filter((d) => d.g.some((g) => s.has(g))); }
  if (f.bm) list = list.filter((d) => store.isBookmarked(d.k));
  return { list, ranked };
}

// ------------------------------------------------------------------ small UI helpers

const icon = {
  star: (on) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  chevron: '<svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  related: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="6" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" stroke="currentColor" stroke-width="2"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  filter: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

const topicIcon = (t, cls = '') => `<span class="ticon ${cls}" style="--c:${esc(t.color)}">${esc(t.icon)}</span>`;
const diffBadge = (d) => (d ? `<span class="diff diff-${d.toLowerCase()}">${esc(d)}</span>` : '');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

const shareUrl = (key) => `${location.origin}${location.pathname}#/q/${key}`;

// ------------------------------------------------------------------ sidebar

function renderSidebar(route) {
  const m = state.manifest;
  const activeTopic = route.view === 'topic' || route.view === 'q' ? route.parts[1] : null;
  if (activeTopic) state.sidebarOpen.add(activeTopic);
  const activeSec = route.params.get('sec');
  const bm = store.bookmarkCount();
  const link = (href, label, active, extra = '') => `<a class="nav-link${active ? ' active' : ''}" href="${href}">${label}${extra}</a>`;

  $('#sidebarInner').innerHTML = `
    <nav class="nav-main">
      ${link('#/', '<span>Home</span>', route.view === 'home')}
      ${link('#/browse', '<span>All questions</span>', route.view === 'browse' && !location.hash.includes('?'), `<span class="count">${m.totals.questions}</span>`)}
      ${link('#/bookmarks', '<span>Bookmarks</span>', route.view === 'bookmarks', `<span class="count">${bm}</span>`)}
    </nav>
    <div class="nav-label">Topics</div>
    <ul class="tree">
      ${m.topics.map((t) => {
        const open = state.sidebarOpen.has(t.slug);
        const active = activeTopic === t.slug;
        return `<li class="tree-topic${active ? ' active' : ''}${open ? ' open' : ''}">
          <div class="tree-row">
            <a href="#/topic/${t.slug}" class="tree-link">${topicIcon(t, 'sm')}<span class="tree-title">${esc(t.title)}</span>
              ${t.count ? `<span class="count">${t.count}</span>` : '<span class="soon">soon</span>'}</a>
            ${t.sections.length ? `<button class="tree-toggle" data-action="tree-toggle" data-slug="${t.slug}" aria-expanded="${open}" aria-label="Toggle ${esc(t.title)} headings">${icon.chevron}</button>` : ''}
          </div>
          ${t.sections.length ? `<ul class="tree-secs">${t.sections.map((s) => `
            <li><a class="tree-sec${active && activeSec === s.id ? ' active' : ''}" href="#/topic/${t.slug}?sec=${s.id}">
              <span>${esc(s.heading)}</span><span class="count">${s.questions.length}</span></a></li>`).join('')}
          </ul>` : ''}
        </li>`;
      }).join('')}
    </ul>
    <div class="sidebar-foot">Content ${new Date(m.generatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${m.totals.topics} topics</div>`;

  const b = $('#bmCount');
  b.textContent = bm;
  b.hidden = !bm;
}

function setSidebar(open) {
  document.body.classList.toggle('nav-open', open);
  $('#scrim').hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', String(open));
}

// ------------------------------------------------------------------ question cards

function questionCard(d, { showTopic = false, snippet = '', query = '', expanded = false } = {}) {
  const t = state.topicBySlug.get(d.t);
  const bm = store.isBookmarked(d.k);
  const title = query ? highlightText(d.q, query, esc) : esc(d.q);
  return `<article class="qcard${expanded ? ' open' : ''}" data-key="${esc(d.k)}" id="q-${esc(d.k.replace('/', '--'))}">
    <div class="qhead">
      <button class="qtoggle" data-action="toggle" aria-expanded="${expanded}">
        ${icon.chevron}<span class="qtitle">${title}</span>
      </button>
      <button class="icon-btn bm${bm ? ' on' : ''}" data-action="bookmark" aria-pressed="${bm}" title="${bm ? 'Remove bookmark' : 'Bookmark'}" aria-label="Bookmark">${icon.star(bm)}</button>
    </div>
    <div class="qmeta">
      ${showTopic ? `<a class="crumb" href="#/topic/${d.t}" style="--c:${esc(t.color)}">${esc(t.title)}</a><span class="crumb-sep">›</span><a class="crumb-sec" href="#/topic/${d.t}?sec=${d.s}">${esc(state.sectionTitle.get(`${d.t}/${d.s}`) || '')}</a>` : ''}
      ${diffBadge(d.d)}
      ${d.g.map((g) => `<button class="tag" data-action="tag" data-tag="${esc(g)}">#${esc(g)}</button>`).join('')}
      ${d.r.length ? `<a class="rel-link" href="#/browse?rel=${esc(d.k)}" title="Show related questions across topics">${icon.related}<span>Related ${d.r.length}</span></a>` : ''}
    </div>
    ${snippet ? `<p class="qsnippet">${highlightText(snippet, query, esc)}</p>` : ''}
    <div class="qbody"${expanded ? '' : ' hidden'}>${expanded ? '<div class="qloading">Loading…</div>' : ''}</div>
  </article>`;
}

function codeCard(c, i) {
  return `<figure class="code-card">
    <figcaption class="code-head">
      <span class="lang">${esc(c.label)}</span>
      <span class="code-title">${esc(c.title || (i ? `Example ${i + 1}` : 'Example'))}</span>
      <button class="copy-btn" data-action="copy-code" title="Copy code">${icon.copy}<span>Copy</span></button>
    </figcaption>
    <pre class="code"><code>${c.html}</code></pre>
  </figure>`;
}

function questionBody(q) {
  const hasDef = q.definition && q.definition.trim();
  const hasAns = q.answer && q.answer.trim();
  if (!hasDef && !hasAns && !q.code.length) return '<div class="empty-q">Answer coming soon — add it to the content file and push.</div>';
  return `
    ${hasDef ? `<section class="card def-card"><h4 class="card-label">Definition</h4><div class="prose">${q.definition}</div></section>` : ''}
    <div class="qa-grid${q.code.length && hasAns ? '' : ' single'}">
      ${hasAns ? `<section class="card ans-card"><h4 class="card-label">Interview answer</h4><div class="prose">${q.answer}</div></section>` : ''}
      ${q.code.length ? `<section class="code-col" aria-label="Code samples"><h4 class="card-label code-label">Code ${q.code.length > 1 ? `<span class="muted">· ${q.code.length} samples</span>` : ''}</h4>${q.code.map(codeCard).join('')}</section>` : ''}
    </div>
    <div class="qfoot">
      <a class="btn ghost sm" href="#/q/${esc(q.key)}">${icon.link}<span>Open</span></a>
      <button class="btn ghost sm" data-action="share">${icon.copy}<span>Copy link</span></button>
      ${q.related.length ? `<a class="btn ghost sm" href="#/browse?rel=${esc(q.key)}">${icon.related}<span>Related (${q.related.length})</span></a>` : ''}
    </div>`;
}

async function fillBody(card) {
  const key = card.dataset.key;
  const body = $('.qbody', card);
  body.hidden = false;
  if (body.dataset.loaded) return;
  body.innerHTML = '<div class="qloading">Loading…</div>';
  try {
    const q = await loadQuestion(key);
    body.innerHTML = q ? questionBody({ ...q, key }) : '<div class="empty-q">Not found.</div>';
    body.dataset.loaded = '1';
  } catch (e) {
    body.innerHTML = `<div class="empty-q">Couldn't load this answer (${esc(e.message)}).</div>`;
  }
}

function toggleCard(card, force) {
  const open = force ?? !card.classList.contains('open');
  card.classList.toggle('open', open);
  $('.qtoggle', card).setAttribute('aria-expanded', String(open));
  if (open) { state.expanded.add(card.dataset.key); fillBody(card); }
  else { state.expanded.delete(card.dataset.key); $('.qbody', card).hidden = true; }
}

// ------------------------------------------------------------------ filter bar

function filterBar(f, route, total, shownCount) {
  const m = state.manifest;
  const onTopicPage = route.view === 'topic';
  const onBm = route.view === 'bookmarks';
  const chips = [];
  if (f.q) chips.push(['q', '', `Search: “${esc(f.q)}”`]);
  if (f.rel) {
    const src = state.docByKey.get(f.rel);
    chips.push(['rel', '', `Related to: ${esc(src ? src.q : f.rel)}`]);
  }
  if (!onTopicPage) f.topics.forEach((s) => chips.push(['topics', s, `Topic: ${esc(state.topicBySlug.get(s)?.title || s)}`]));
  f.diff.forEach((d) => chips.push(['diff', d, `Difficulty: ${d}`]));
  f.tags.forEach((t) => chips.push(['tags', t, `#${esc(t)}`]));
  if (f.bm && !onBm) chips.push(['bm', '', 'Bookmarked']);

  const pop = (id, label, count, inner) => `
    <div class="pop${state.openPop === id ? ' open' : ''}" data-pop="${id}">
      <button class="btn sm${count ? ' active' : ''}" data-action="pop" data-pop="${id}" aria-expanded="${state.openPop === id}">
        ${label}${count ? ` <span class="pill">${count}</span>` : ''} ${icon.down}</button>
      <div class="pop-panel" role="dialog" aria-label="${label}">${inner}</div>
    </div>`;

  const topicCounts = new Map();
  const tagCounts = new Map(m.tags.map((t) => [t.tag, t.count]));

  return `<div class="filters" role="region" aria-label="Filters">
    <div class="filter-row">
      <span class="filter-label">${icon.filter}<span>Filter</span></span>
      ${onTopicPage ? '' : pop('topics', 'Topics', f.topics.length, `
        <div class="pop-list">${m.topics.filter((t) => t.count).map((t) => `
          <label class="check"><input type="checkbox" data-filter="topics" value="${t.slug}"${f.topics.includes(t.slug) ? ' checked' : ''}>
          ${topicIcon(t, 'xs')}<span>${esc(t.title)}</span><span class="count">${topicCounts.get(t.slug) ?? t.count}</span></label>`).join('')}
        </div>`)}
      <div class="seg" role="group" aria-label="Difficulty">
        ${DIFFS.map((d) => `<button class="seg-btn diff-${d.toLowerCase()}${f.diff.includes(d) ? ' on' : ''}" data-action="diff" data-diff="${d}" aria-pressed="${f.diff.includes(d)}">${d}</button>`).join('')}
      </div>
      ${pop('tags', 'Tags', f.tags.length, `
        <input class="pop-search" type="search" placeholder="Filter tags…" data-action="tag-search" aria-label="Filter tags">
        <div class="pop-list tags-list">${m.tags.map((t) => `
          <label class="check" data-tagname="${esc(t.tag)}"><input type="checkbox" data-filter="tags" value="${esc(t.tag)}"${f.tags.includes(t.tag) ? ' checked' : ''}>
          <span>#${esc(t.tag)}</span><span class="count">${tagCounts.get(t.tag)}</span></label>`).join('')}
        </div>`)}
      ${onBm ? '' : `<button class="btn sm${f.bm ? ' active' : ''}" data-action="bm-filter" aria-pressed="${f.bm}">${icon.star(f.bm)}<span>Bookmarked</span></button>`}
      ${f.q ? `<div class="seg scope-seg" role="group" aria-label="Search in">
        <button class="seg-btn${f.scope === 'head' ? ' on' : ''}" data-action="scope" data-scope="head">Headings</button>
        <button class="seg-btn${f.scope === 'all' ? ' on' : ''}" data-action="scope" data-scope="all">Full text</button></div>` : ''}
      <span class="spacer"></span>
      <button class="btn sm ghost" data-action="expand-all">Expand all</button>
      <button class="btn sm ghost" data-action="collapse-all">Collapse</button>
    </div>
    ${chips.length ? `<div class="chips" aria-label="Active filters">
      ${chips.map(([k, v, label]) => `<button class="chip" data-action="remove-filter" data-k="${k}" data-v="${esc(v)}" title="Remove filter">${label}${icon.x}</button>`).join('')}
      <button class="link-btn" data-action="clear-filters">Clear all</button>
    </div>` : ''}
    <div class="result-count">${total === shownCount ? `${total} question${total === 1 ? '' : 's'}` : `Showing ${shownCount} of ${total} questions`}</div>
  </div>`;
}

// ------------------------------------------------------------------ views

function renderHome() {
  const m = state.manifest;
  const bms = store.bookmarkKeys().map((k) => state.docByKey.get(k)).filter(Boolean).slice(0, 5);
  const diffCount = (d) => allDocs().filter((x) => x.d === d).length;
  return `<div class="home">
    <section class="hero">
      <p class="eyebrow">.NET interview preparation</p>
      <h1>Every answer you need, <span class="accent">one search away.</span></h1>
      <p class="lead">Questions grouped by topic and heading, each with a crisp definition, an interview-style answer and runnable-looking code. Press <kbd>/</kbd> to search.</p>
      <div class="stats">
        <div><strong>${m.totals.topics}</strong><span>topics</span></div>
        <div><strong>${m.totals.questions}</strong><span>questions</span></div>
        ${DIFFS.map((d) => `<a href="#/browse?diff=${d}" class="stat-diff diff-${d.toLowerCase()}"><strong>${diffCount(d)}</strong><span>${d}</span></a>`).join('')}
        <a href="#/bookmarks"><strong>${store.bookmarkCount()}</strong><span>bookmarked</span></a>
      </div>
    </section>

    <h2 class="section-title">Topics</h2>
    <div class="topic-grid">
      ${m.topics.map((t) => `<a class="topic-card${t.count ? '' : ' empty'}" href="#/topic/${t.slug}" style="--c:${esc(t.color)}">
        <div class="topic-card-top">${topicIcon(t)}<span class="${t.count ? 'count' : 'soon'}">${t.count ? `${t.count} Q` : 'Coming soon'}</span></div>
        <h3>${esc(t.title)}</h3>
        <p>${esc(t.description || (t.count ? '' : 'No questions yet — add them to ' + t.file))}</p>
        ${t.sections.length ? `<ul class="topic-secs">${t.sections.slice(0, 4).map((s) => `<li>${esc(s.heading)}</li>`).join('')}${t.sections.length > 4 ? `<li>+${t.sections.length - 4} more</li>` : ''}</ul>` : ''}
      </a>`).join('')}
    </div>

    ${bms.length ? `<h2 class="section-title">Your bookmarks <a class="see-all" href="#/bookmarks">See all</a></h2>
      <div class="qlist">${bms.map((d) => questionCard(d, { showTopic: true })).join('')}</div>` : ''}

    <h2 class="section-title">Popular tags</h2>
    <div class="tag-cloud">${m.tags.slice(0, 30).map((t) => `<a class="tag" href="#/browse?tags=${encodeURIComponent(t.tag)}">#${esc(t.tag)} <span>${t.count}</span></a>`).join('')}</div>
  </div>`;
}

function renderList(route) {
  const f = currentFilters(route);
  if (f.q && f.scope === 'all') warmFullText();
  const { list, ranked } = filterDocs(f);
  const sig = JSON.stringify([route.view, f]);
  if (sig !== state.lastListSig) { state.shown = PAGE; state.lastListSig = sig; }
  const shownList = list.slice(0, state.shown);
  const topic = route.view === 'topic' ? state.topicBySlug.get(route.parts[1]) : null;

  let header = '';
  if (topic) {
    header = `<header class="page-head topic-head" style="--c:${esc(topic.color)}">
      ${topicIcon(topic, 'lg')}
      <div><p class="eyebrow"><a href="#/">Topics</a> › ${esc(topic.title)}</p>
      <h1>${esc(topic.title)}</h1>${topic.description ? `<p class="lead">${esc(topic.description)}</p>` : ''}</div>
    </header>
    ${topic.sections.length > 1 ? `<nav class="toc" aria-label="Headings">${topic.sections.map((s) => `<a href="#/topic/${topic.slug}?sec=${s.id}">${esc(s.heading)} <span>${s.questions.length}</span></a>`).join('')}</nav>` : ''}`;
  } else if (route.view === 'bookmarks') {
    header = `<header class="page-head"><div><h1>Bookmarks</h1><p class="lead">Questions you've starred. Saved in this browser.</p></div>
      <div class="head-actions"><button class="btn sm" data-action="export-bm">Export</button>
      <label class="btn sm">Import<input type="file" accept="application/json" data-action="import-bm" hidden></label></div></header>`;
  } else {
    const title = f.rel ? 'Related questions' : f.q ? 'Search results' : 'All questions';
    header = `<header class="page-head"><div><h1>${title}</h1>${f.rel ? `<p class="lead">Connected content across topics, ranked by shared tags and similar wording.</p>` : ''}</div></header>`;
  }

  if (topic && !topic.count) {
    return `${header}<div class="empty-state"><div class="empty-ico">✎</div><h2>Coming soon</h2>
      <p>This topic exists but has no questions yet. Add them to <code>content/${esc(topic.file)}</code> and push — the site rebuilds automatically.</p>
      <a class="btn" href="#/">Back to topics</a></div>`;
  }

  let body = '';
  if (!list.length) {
    body = `<div class="empty-state"><div class="empty-ico">∅</div><h2>No matching questions</h2>
      <p>${route.view === 'bookmarks' && !f.q && !f.diff.length && !f.tags.length ? 'Tap the ☆ on any question to bookmark it.' : 'Try removing a filter or searching with different words.'}</p>
      ${f.q && f.scope === 'head' ? `<button class="btn" data-action="scope" data-scope="all">Search full text instead</button>` : ''}</div>`;
  } else if (ranked) {
    body = `<div class="qlist">${shownList.map((d) => questionCard(d, { showTopic: true, snippet: f.q ? d.x : '', query: f.q, expanded: state.expanded.has(d.k) })).join('')}</div>`;
  } else {
    // hierarchical: topic → heading → questions
    const multiTopic = !topic;
    let html = '';
    let curT = null, curS = null;
    for (const d of shownList) {
      if (d.t !== curT) {
        if (curT) html += '</div></section>';
        if (curS) curS = null;
        curT = d.t;
        const t = state.topicBySlug.get(d.t);
        if (multiTopic) html += `<h2 class="group-topic" style="--c:${esc(t.color)}">${topicIcon(t, 'sm')}<a href="#/topic/${t.slug}">${esc(t.title)}</a></h2>`;
        html += '<section class="group"><div>';
      }
      if (d.s !== curS) {
        curS = d.s;
        html += `</div><h3 class="group-sec" id="sec-${d.t}-${d.s}">${esc(state.sectionTitle.get(`${d.t}/${d.s}`))}</h3><div class="qlist">`;
      }
      html += questionCard(d, { expanded: state.expanded.has(d.k) });
    }
    body = html + '</div></section>';
  }

  const more = list.length > shownList.length
    ? `<div class="more"><button class="btn" data-action="more">Show ${Math.min(PAGE, list.length - shownList.length)} more</button></div>` : '';

  return `${header}${filterBar(f, route, list.length, shownList.length)}${body}${more}`;
}

async function renderQuestion(route, main) {
  const key = `${route.parts[1]}/${route.parts[2]}`;
  const d = state.docByKey.get(key);
  if (!d) { main.innerHTML = notFound(); return; }
  const t = state.topicBySlug.get(d.t);
  const order = allDocs().filter((x) => x.t === d.t);
  const i = order.findIndex((x) => x.k === key);
  const prev = order[i - 1], next = order[i + 1];
  const bm = store.isBookmarked(key);
  const relDocs = d.r.map((k) => state.docByKey.get(k)).filter(Boolean);

  main.innerHTML = `<article class="qpage" data-key="${esc(key)}">
    <p class="eyebrow crumbs"><a href="#/">Topics</a> › <a href="#/topic/${t.slug}">${esc(t.title)}</a> › <a href="#/topic/${t.slug}?sec=${d.s}">${esc(state.sectionTitle.get(`${d.t}/${d.s}`))}</a></p>
    <header class="qpage-head">
      <h1>${esc(d.q)}</h1>
      <button class="icon-btn bm lg${bm ? ' on' : ''}" data-action="bookmark" aria-pressed="${bm}" title="Bookmark">${icon.star(bm)}</button>
    </header>
    <div class="qmeta">${diffBadge(d.d)}${d.g.map((g) => `<a class="tag" href="#/browse?tags=${encodeURIComponent(g)}">#${esc(g)}</a>`).join('')}</div>
    <div class="qbody"><div class="qloading">Loading…</div></div>
    <nav class="pager">
      ${prev ? `<a class="pager-link" href="#/q/${prev.k}"><span>← Previous</span><strong>${esc(prev.q)}</strong></a>` : '<span></span>'}
      ${next ? `<a class="pager-link next" href="#/q/${next.k}"><span>Next →</span><strong>${esc(next.q)}</strong></a>` : '<span></span>'}
    </nav>
    ${relDocs.length ? `<section class="related"><h2 class="section-title">Related questions <a class="see-all" href="#/browse?rel=${esc(key)}">Filter view</a></h2>
      <div class="qlist">${relDocs.map((r) => questionCard(r, { showTopic: true })).join('')}</div></section>` : ''}
  </article>`;

  const body = $('.qpage > .qbody', main);
  try {
    const q = await loadQuestion(key);
    body.innerHTML = questionBody({ ...q, key });
  } catch (e) { body.innerHTML = `<div class="empty-q">Couldn't load (${esc(e.message)}).</div>`; }
}

const notFound = () => `<div class="empty-state"><div class="empty-ico">?</div><h2>Not found</h2><p>That page or question doesn't exist (it may have been renamed).</p><a class="btn" href="#/">Go home</a></div>`;

async function render() {
  const route = parseHash();
  const main = $('#main');
  renderSidebar(route);
  setSidebar(false);
  closeSuggestions();

  // keep the header search box in sync with the route
  const input = $('#searchInput');
  if (document.activeElement !== input) input.value = route.filters.q;
  syncScopeButtons(currentFilters(route).scope);

  const prevKey = render.lastPath;
  render.lastPath = route.view + '/' + route.parts.slice(1).join('/');

  if (route.view === 'home') { main.innerHTML = renderHome(); document.title = '.NET Interview Prep'; }
  else if (route.view === 'browse' || route.view === 'bookmarks' || route.view === 'topic') {
    if (route.view === 'topic' && !state.topicBySlug.has(route.parts[1])) { main.innerHTML = notFound(); return; }
    main.innerHTML = renderList(route);
    $$('.qcard.open', main).forEach((c) => fillBody(c));
    const t = route.view === 'topic' ? state.topicBySlug.get(route.parts[1]) : null;
    document.title = `${t ? t.title : route.view === 'bookmarks' ? 'Bookmarks' : 'Questions'} · .NET Interview Prep`;
  } else if (route.view === 'q' && route.parts[2]) {
    await renderQuestion(route, main);
    document.title = `${state.docByKey.get(`${route.parts[1]}/${route.parts[2]}`)?.q || 'Question'} · .NET Interview Prep`;
  } else main.innerHTML = notFound();

  const sec = route.params.get('sec');
  if (sec) {
    const el = document.getElementById(`sec-${route.parts[1]}-${sec}`);
    if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
  } else if (prevKey !== render.lastPath) window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ autocomplete

let sugItems = [];
let sugActive = -1;

function closeSuggestions() {
  const box = $('#suggestions');
  box.hidden = true;
  $('#searchBox').setAttribute('aria-expanded', 'false');
  sugActive = -1;
}

function syncScopeButtons(scope) {
  $$('.scope-btn').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
}

function buildSuggestions(q) {
  const scope = state.scope;
  if (scope === 'all') warmFullText();
  const results = search(q, scope);
  const items = [];
  const ql = q.trim().toLowerCase();

  // Topics & headings whose names contain the text
  for (const t of state.manifest.topics) {
    if (t.title.toLowerCase().includes(ql) && items.filter((x) => x.type === 'topic').length < 2) items.push({ type: 'topic', t, href: `#/topic/${t.slug}` });
  }
  for (const t of state.manifest.topics) for (const s of t.sections) {
    if (s.heading.toLowerCase().includes(ql) && items.filter((x) => x.type === 'sec').length < 3) items.push({ type: 'sec', t, s, href: `#/topic/${t.slug}?sec=${s.id}` });
  }
  results.slice(0, 7).forEach((r) => items.push({ type: 'q', d: r.doc, href: `#/q/${r.doc.k}` }));
  return { items, total: results.length };
}

function renderSuggestions() {
  const input = $('#searchInput');
  const q = input.value;
  const box = $('#suggestions');
  if (!q.trim()) { closeSuggestions(); return; }
  const { items, total } = buildSuggestions(q);
  sugItems = items;
  sugActive = -1;
  const groups = { topic: 'Topics', sec: 'Headings', q: 'Questions' };
  let html = '';
  let last = '';
  items.forEach((it, i) => {
    if (it.type !== last) { html += `<div class="sug-group">${groups[it.type]}</div>`; last = it.type; }
    if (it.type === 'q') {
      const t = state.topicBySlug.get(it.d.t);
      html += `<a class="sug" role="option" id="sug-${i}" data-i="${i}" href="${it.href}">
        <span class="sug-main">${highlightText(it.d.q, q, esc)}</span>
        <span class="sug-sub"><span class="dot" style="--c:${esc(t.color)}"></span>${esc(t.title)} › ${esc(state.sectionTitle.get(`${it.d.t}/${it.d.s}`))}${it.d.d ? ` · ${it.d.d}` : ''}</span></a>`;
    } else if (it.type === 'sec') {
      html += `<a class="sug" role="option" id="sug-${i}" data-i="${i}" href="${it.href}">
        <span class="sug-main">${highlightText(it.s.heading, q, esc)}</span>
        <span class="sug-sub"><span class="dot" style="--c:${esc(it.t.color)}"></span>${esc(it.t.title)} · ${it.s.questions.length} questions</span></a>`;
    } else {
      html += `<a class="sug" role="option" id="sug-${i}" data-i="${i}" href="${it.href}">
        <span class="sug-main">${topicIcon(it.t, 'xs')} ${highlightText(it.t.title, q, esc)}</span>
        <span class="sug-sub">${it.t.count} questions</span></a>`;
    }
  });
  if (!items.length) html = `<div class="sug-empty">No matches in ${state.scope === 'head' ? 'headings' : 'content'}.${state.scope === 'head' ? ' <button class="link-btn" data-action="sug-full">Search full text</button>' : ''}</div>`;
  html += `<a class="sug-all" href="#/browse${filtersToQuery({ q, scope: state.scope, topics: [], diff: [], tags: [], bm: false, rel: '' })}">
    ${total ? `See all ${total} result${total === 1 ? '' : 's'}` : 'Open search page'} <kbd>Enter</kbd></a>`;
  box.innerHTML = html;
  box.hidden = false;
  $('#searchBox').setAttribute('aria-expanded', 'true');
}

function moveSuggestion(dir) {
  const opts = $$('#suggestions .sug');
  if (!opts.length) return;
  sugActive = (sugActive + dir + opts.length) % opts.length;
  opts.forEach((o, i) => o.classList.toggle('active', i === sugActive));
  opts[sugActive].scrollIntoView({ block: 'nearest' });
  $('#searchInput').setAttribute('aria-activedescendant', opts[sugActive].id);
}

function submitSearch() {
  const q = $('#searchInput').value.trim();
  const route = parseHash();
  closeSuggestions();
  if (!q) return;
  const f = route.view === 'browse' ? { ...currentFilters(route), q, scope: state.scope } : { q, scope: state.scope, topics: [], diff: [], tags: [], bm: false, rel: '' };
  go(`#/browse${filtersToQuery(f)}`);
}

// ------------------------------------------------------------------ events

function updateFilters(mutate) {
  const route = parseHash();
  const f = currentFilters(route);
  f.topics = [...f.topics]; f.diff = [...f.diff]; f.tags = [...f.tags];
  mutate(f);
  go(listHash(f, route), { replace: true });
}

function toggleIn(arr, v) { const i = arr.indexOf(v); if (i > -1) arr.splice(i, 1); else arr.push(v); }

function bindEvents() {
  window.addEventListener('hashchange', render);

  $('#menuBtn').addEventListener('click', () => setSidebar(!document.body.classList.contains('nav-open')));
  $('#scrim').addEventListener('click', () => setSidebar(false));

  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.setTheme(next);
  });

  // search box
  const input = $('#searchInput');
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      renderSuggestions();
      const route = parseHash();
      if (route.view === 'browse' && (route.filters.q || input.value.trim())) {
        const f = { ...currentFilters(route), q: input.value.trim(), scope: state.scope };
        history.replaceState(null, '', `#/browse${filtersToQuery(f)}`);
        const main = $('#main');
        main.innerHTML = renderList(parseHash());
        $$('.qcard.open', main).forEach((c) => fillBody(c));
      }
    }, 90);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) renderSuggestions(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if ($('#suggestions').hidden) renderSuggestions(); moveSuggestion(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggestion(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const opts = $$('#suggestions .sug');
      if (sugActive > -1 && opts[sugActive]) { location.hash = opts[sugActive].getAttribute('href'); closeSuggestions(); input.blur(); }
      else { submitSearch(); input.blur(); }
    } else if (e.key === 'Escape') { closeSuggestions(); input.blur(); }
  });
  $('#suggestions').addEventListener('mousedown', (e) => e.preventDefault()); // keep focus while clicking
  $('#suggestions').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="sug-full"]')) { setScope('all'); renderSuggestions(); return; }
    if (e.target.closest('a')) { closeSuggestions(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(closeSuggestions, 120));
  $$('.scope-btn').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
  $$('.scope-btn').forEach((b) => b.addEventListener('click', () => {
    setScope(b.dataset.scope);
    if (input.value.trim()) { renderSuggestions(); input.focus(); }
    const route = parseHash();
    if (route.view === 'browse' && route.filters.q) updateFilters((f) => { f.scope = state.scope; });
  }));

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); }
    if (e.key === 'Escape') { if (state.openPop) { state.openPop = null; $$('.pop.open').forEach((p) => p.classList.remove('open')); } setSidebar(false); }
  });

  // close popovers on outside click
  document.addEventListener('click', (e) => {
    if (state.openPop && !e.target.closest('.pop')) { state.openPop = null; $$('.pop.open').forEach((p) => p.classList.remove('open')); }
  });

  // delegated actions in main + sidebar
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.closest('#suggestions')) return;
    const a = el.dataset.action;
    const card = el.closest('[data-key]');
    switch (a) {
      case 'toggle': toggleCard(card); break;
      case 'bookmark': {
        const on = store.toggleBookmark(card.dataset.key);
        $$(`[data-key="${CSS.escape(card.dataset.key)}"] > .qhead .bm, .qpage[data-key="${CSS.escape(card.dataset.key)}"] .qpage-head .bm`).forEach((b) => {
          b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.innerHTML = icon.star(on);
        });
        toast(on ? 'Bookmarked' : 'Bookmark removed');
        renderSidebar(parseHash());
        if (parseHash().view === 'bookmarks' && !on) { card.classList.add('removing'); setTimeout(render, 200); }
        break;
      }
      case 'share': if (await copyText(shareUrl(card.dataset.key))) toast('Link copied'); break;
      case 'copy-code': {
        const code = el.closest('.code-card').querySelector('code').innerText;
        if (await copyText(code)) { const s = $('span', el); s.textContent = 'Copied'; setTimeout(() => (s.textContent = 'Copy'), 1400); }
        break;
      }
      case 'tag': updateFilters((f) => { if (!f.tags.includes(el.dataset.tag)) f.tags.push(el.dataset.tag); }); break;
      case 'diff': updateFilters((f) => toggleIn(f.diff, el.dataset.diff)); break;
      case 'bm-filter': updateFilters((f) => { f.bm = !f.bm; }); break;
      case 'scope': setScope(el.dataset.scope); updateFilters((f) => { f.scope = el.dataset.scope; }); break;
      case 'remove-filter': updateFilters((f) => {
        const { k, v } = el.dataset;
        if (k === 'q') f.q = ''; else if (k === 'rel') f.rel = ''; else if (k === 'bm') f.bm = false; else toggleIn(f[k], v);
      }); break;
      case 'clear-filters': {
        const route = parseHash();
        if (route.view === 'topic') go(`#/topic/${route.parts[1]}`);
        else if (route.view === 'bookmarks') go('#/bookmarks');
        else go('#/browse');
        break;
      }
      case 'pop': e.stopPropagation(); {
        const id = el.dataset.pop;
        state.openPop = state.openPop === id ? null : id;
        $$('.pop').forEach((p) => p.classList.toggle('open', p.dataset.pop === state.openPop));
        if (state.openPop) $('.pop.open .pop-search')?.focus();
        break;
      }
      case 'expand-all': {
        const cards = $$('#main .qcard');
        cards.forEach((c) => toggleCard(c, true));
        break;
      }
      case 'collapse-all': $$('#main .qcard').forEach((c) => toggleCard(c, false)); break;
      case 'more': state.shown += PAGE; { const y = scrollY; const main = $('#main'); main.innerHTML = renderList(parseHash()); $$('.qcard.open', main).forEach((c) => fillBody(c)); scrollTo(0, y); } break;
      case 'tree-toggle': {
        const s = el.dataset.slug;
        if (state.sidebarOpen.has(s)) state.sidebarOpen.delete(s); else state.sidebarOpen.add(s);
        el.closest('.tree-topic').classList.toggle('open');
        el.setAttribute('aria-expanded', String(state.sidebarOpen.has(s)));
        break;
      }
      case 'export-bm': {
        const blob = new Blob([store.exportBookmarks()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement('a'), { href: url, download: 'interview-bookmarks.json' });
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        break;
      }
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.filter) {
      state.openPop = el.closest('.pop')?.dataset.pop || null;
      updateFilters((f) => toggleIn(f[el.dataset.filter], el.value));
    } else if (el.dataset.action === 'import-bm' && el.files[0]) {
      try { store.importBookmarks(await el.files[0].text()); toast('Bookmarks imported'); render(); }
      catch { toast('That file is not a bookmarks export'); }
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.dataset.action === 'tag-search') {
      const v = e.target.value.trim().toLowerCase();
      $$('.tags-list .check').forEach((l) => { l.hidden = v && !l.dataset.tagname.includes(v); });
    }
  });

  // sidebar links close the drawer on mobile
  $('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) setSidebar(false); });

  // preserve focus for popover search after re-render
  store.onChange(() => {});
}

function setScope(s) {
  state.scope = s === 'all' ? 'all' : 'head';
  store.setPref('scope', state.scope);
  syncScopeButtons(state.scope);
  if (state.scope === 'all') warmFullText();
}

/** Fetch the full-text index if needed, then refresh whatever search UI is visible. */
function warmFullText() {
  if (bodyReady()) return;
  ensureBody().then((fresh) => {
    if (!fresh) return;
    if (!$('#suggestions').hidden) renderSuggestions();
    const r = parseHash();
    if (r.filters.q && currentFilters(r).scope === 'all') render();
  }).catch(() => toast('Full-text index failed to load'));
}

// ------------------------------------------------------------------ boot

async function boot() {
  bindEvents();
  try {
    const [manifest, searchData] = await Promise.all([getJSON('data/manifest.json'), getJSON('data/search.json')]);
    state.manifest = manifest;
    for (const t of manifest.topics) {
      state.topicBySlug.set(t.slug, t);
      for (const s of t.sections) state.sectionTitle.set(`${t.slug}/${s.id}`, s.heading);
    }
    initSearch(searchData, () => getJSON('data/search-body.json'));
    for (const d of searchData.docs) state.docByKey.set(d.k, d);
    syncScopeButtons(state.scope);
    await render();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty-state"><div class="empty-ico">!</div><h2>Couldn't load content</h2>
      <p>${esc(e.message)}</p><p class="muted">Run <code>node scripts/build.mjs</code> to generate <code>dist/data</code>, then serve the <code>dist</code> folder (opening index.html directly from disk won't work).</p></div>`;
    console.error(e);
  }
}

boot();
