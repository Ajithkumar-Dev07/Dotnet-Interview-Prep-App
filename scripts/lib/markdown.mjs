// Minimal, dependency-free Markdown → HTML renderer (build time only).
// Supports: headings, paragraphs, bold/italic/strike, inline code, links,
// ordered/unordered (nested) lists, blockquotes, GFM tables, hr, fenced code.

import { escapeHtml, highlight, langLabel } from './highlight.mjs';

const esc = escapeHtml;

export function inline(src) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(src);
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const safe = /^(https?:|mailto:|#|\/|\.)/i.test(u) ? u : '#';
    const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener"' : '';
    return keep(`<a href="${esc(safe)}"${ext}>${inline(t)}</a>`);
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  return s;
}

export function codeBlockHtml(code, lang, title) {
  return `<div class="code-inline"><div class="code-inline-head"><span>${esc(title || langLabel(lang))}</span></div>` +
    `<pre class="code"><code>${highlight(code, lang)}</code></pre></div>`;
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function renderList(lines, start) {
  // Collects a (possibly nested) list beginning at `start`; returns [html, nextIndex]
  const first = lines[start].match(listRe);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  let html = ordered ? '<ol>' : '<ul>';
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(listRe);
    if (!m) {
      // continuation line of the previous item
      if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && html.endsWith('</li>')) {
        html = html.slice(0, -5) + ' ' + inline(lines[i].trim()) + '</li>';
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const [sub, next] = renderList(lines, i);
      html = html.endsWith('</li>') ? html.slice(0, -5) + sub + '</li>' : html + sub;
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    let text = m[3];
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) text = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}`;
    else text = inline(text);
    html += `<li>${text}</li>`;
    i++;
  }
  return [html + (ordered ? '</ol>' : '</ul>'), i];
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++;
      const title = (fence[3].match(/title\s*=\s*"([^"]*)"/) || [])[1];
      html += codeBlockHtml(body.join('\n'), fence[2], title);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(6, h[1].length + 2); // demote: answers live inside cards
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += '<hr>'; i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      let t = '<div class="table-wrap"><table><thead><tr>' +
        head.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i++]);
        t += '<tr>' + head.map((_, k) => `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(cells[k] ?? '')}</td>`).join('') + '</tr>';
      }
      html += t + '</tbody></table></div>';
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`;
      continue;
    }

    if (listRe.test(line)) {
      const [l, next] = renderList(lines, i);
      html += l;
      i = next;
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) && !listRe.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) para.push(lines[i++].trim());
    html += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return html;
}

/** Rough plain-text version of markdown, for search snippets/indexing. */
export function toPlain(src) {
  return String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~>#|]/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
