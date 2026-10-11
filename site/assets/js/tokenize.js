// Shared tokenizer — imported by the build script (Node) AND the browser,
// so indexed terms and query terms are always normalised the same way.

const STOP = new Set(
  ('a an and are as at be by can do does for from has have how i if in into is it its ' +
   'of on or so than that the their them then there these they this to use used using ' +
   'vs was we what when where which while who why will with you your my me our would should could')
    .split(' ')
);

const ALIASES = [
  [/c#/g, ' csharp '],
  [/f#/g, ' fsharp '],
  [/\.net\b/g, ' dotnet '],
  [/asp\.net/g, ' aspnet '],
  [/ef\s*core/g, ' efcore '],
  [/entity framework core/g, ' efcore '],
  [/span<t>/g, ' span '],
];

export function normalize(text) {
  let s = String(text || '').toLowerCase();
  for (const [re, rep] of ALIASES) s = s.replace(re, rep);
  return s;
}

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Split text into normalised search terms. keepStop=true keeps stop words (used for autocomplete). */
export function tokenize(text, keepStop = false) {
  const out = [];
  const words = normalize(text).split(/[^a-z0-9]+/);
  for (const w of words) {
    if (!w) continue;
    if (!keepStop && STOP.has(w)) continue;
    if (w.length === 1 && !/[0-9]/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}
