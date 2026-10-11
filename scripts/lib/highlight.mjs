// Tiny, dependency-free syntax highlighter used at build time.
// Produces <span class="tok-*"> markup; colours live in styles.css.

export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const words = (s) => new Set(s.trim().split(/\s+/));

const CSHARP_KW = words(`
abstract as async await base bool break byte case catch char checked class const continue decimal default
delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in
init int interface internal is lock long namespace new null object operator out override params private
protected public readonly record ref required return sbyte sealed short sizeof stackalloc static string struct
switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while
yield get set value when where select from orderby group by into let join on equals ascending descending
nameof not and or with global file scoped dynamic nint nuint`);

const JS_KW = words(`
async await break case catch class const continue debugger default delete do else export extends false
finally for function if import in instanceof let new null of return static super switch this throw true try
typeof undefined var void while yield interface type implements enum readonly public private protected`);

const SQL_KW = words(`
select from where and or not insert into values update set delete create alter drop table view index
procedure proc function trigger as on join inner left right full outer cross apply group by order having
distinct top limit offset fetch next rows only union all exists in is null like between case when then
else end begin commit rollback transaction tran declare exec execute primary key foreign references
constraint default identity unique clustered nonclustered include with nolock over partition row_number
rank dense_rank lag lead count sum avg min max cast convert isnull coalesce asc desc go if while return
output inserted deleted merge using matched isolation level read committed uncommitted repeatable
serializable snapshot try catch throw print nvarchar varchar int bigint bit datetime datetime2 decimal
money uniqueidentifier date float char nchar text table_name schemabinding recursive lateral filter
statistics plan getdate sysdatetime newid string_agg first_value last_value ntile percent`);

const BASH_KW = words(`if then else fi for do done while case esac function in export echo cd dotnet npm git
az docker kubectl sudo set param new get`);

function engine(rules, identClassifier) {
  return (code) => {
    let i = 0;
    let out = '';
    let plain = '';
    const flush = () => { if (plain) { out += escapeHtml(plain); plain = ''; } };
    outer: while (i < code.length) {
      for (const [re, cls] of rules) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m.index === i && m[0].length) {
          flush();
          let c = cls;
          if (typeof cls === 'function') c = cls(m[0], code, i + m[0].length);
          out += c ? `<span class="tok-${c}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
          i += m[0].length;
          continue outer;
        }
      }
      plain += code[i++];
    }
    flush();
    return out;
  };
}

const nextNonSpace = (code, pos) => {
  while (pos < code.length && (code[pos] === ' ' || code[pos] === '\t')) pos++;
  return code[pos];
};

const cLikeIdent = (kw) => (w, code, end) => {
  if (kw.has(w)) return 'kw';
  if (nextNonSpace(code, end) === '(') return 'fn';
  if (/^[A-Z]/.test(w)) return 'type';
  return null;
};

const csharp = engine([
  [/\/\/[^\n]*/y, 'com'],
  [/\/\*[\s\S]*?\*\//y, 'com'],
  [/"""[\s\S]*?"""/y, 'str'],
  [/\$?@"(?:[^"]|"")*"|@?\$"(?:[^"\\\n]|\\.)*"/y, 'str'],
  [/"(?:[^"\\\n]|\\.)*"/y, 'str'],
  [/'(?:[^'\\\n]|\\.)'/y, 'str'],
  [/#[a-z]+[^\n]*/y, 'meta'],
  [/\[(?=[A-Z][A-Za-z]*(\(|\]))/y, null],
  [/\b\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[mMfFdDlLuU]*\b|0x[0-9a-fA-F]+/y, 'num'],
  [/[A-Za-z_][A-Za-z0-9_]*/y, cLikeIdent(CSHARP_KW)],
  [/=>|[-+*/%=!<>&|^~?:]+/y, 'op'],
]);

const js = engine([
  [/\/\/[^\n]*/y, 'com'],
  [/\/\*[\s\S]*?\*\//y, 'com'],
  [/`(?:[^`\\]|\\.)*`/y, 'str'],
  [/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y, 'str'],
  [/\b\d+(\.\d+)?\b/y, 'num'],
  [/[A-Za-z_$][A-Za-z0-9_$]*/y, cLikeIdent(JS_KW)],
  [/=>|[-+*/%=!<>&|^~?:]+/y, 'op'],
]);

const sql = engine([
  [/--[^\n]*/y, 'com'],
  [/\/\*[\s\S]*?\*\//y, 'com'],
  [/N?'(?:[^']|'')*'/y, 'str'],
  [/@@?[A-Za-z_][A-Za-z0-9_]*/y, 'var'],
  [/\b\d+(\.\d+)?\b/y, 'num'],
  [/\[[^\]\n]+\]/y, null],
  [/[A-Za-z_][A-Za-z0-9_]*/y, (w, code, end) => (SQL_KW.has(w.toLowerCase()) ? 'kw' : nextNonSpace(code, end) === '(' ? 'fn' : null)],
  [/[-+*/%=<>!]+/y, 'op'],
]);

const json = engine([
  [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'key'],
  [/"(?:[^"\\\n]|\\.)*"/y, 'str'],
  [/-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b/y, 'num'],
  [/\b(true|false|null)\b/y, 'kw'],
  [/\/\/[^\n]*/y, 'com'],
]);

const xml = engine([
  [/<!--[\s\S]*?-->/y, 'com'],
  [/<\/?[A-Za-z][\w:.-]*/y, 'kw'],
  [/\/?>/y, 'kw'],
  [/[A-Za-z_:][\w:.-]*(?==)/y, 'key'],
  [/"[^"]*"|'[^']*'/y, 'str'],
  [/@[A-Za-z_][\w.]*/y, 'var'],
]);

const bash = engine([
  [/#[^\n]*/y, 'com'],
  [/"(?:[^"\\]|\\.)*"|'[^']*'/y, 'str'],
  [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y, 'var'],
  [/--?[A-Za-z][\w-]*/y, 'key'],
  [/[A-Za-z_][A-Za-z0-9_-]*/y, (w) => (BASH_KW.has(w.toLowerCase()) ? 'kw' : null)],
]);

const yaml = engine([
  [/#[^\n]*/y, 'com'],
  [/^[ \t-]*[A-Za-z_][\w.-]*(?=\s*:)/my, 'key'],
  [/"(?:[^"\\]|\\.)*"|'[^']*'/y, 'str'],
  [/\b\d+(\.\d+)?\b/y, 'num'],
  [/\b(true|false|null|on)\b/y, 'kw'],
]);

const http = engine([
  [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/my, 'kw'],
  [/^HTTP\/[\d.]+ \d{3}[^\n]*/my, 'kw'],
  [/^[A-Za-z-]+(?=:)/my, 'key'],
  [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'key'],
  [/"(?:[^"\\\n]|\\.)*"/y, 'str'],
  [/\b\d+(\.\d+)?\b/y, 'num'],
  [/\b(true|false|null)\b/y, 'kw'],
]);

const LANGS = {
  csharp, cs: csharp, 'c#': csharp,
  js, javascript: js, ts: js, typescript: js,
  sql, tsql: sql, 't-sql': sql,
  json, jsonc: json,
  xml, html: xml, csproj: xml, razor: xml, cshtml: xml,
  bash, sh: bash, shell: bash, powershell: bash, ps1: bash, pwsh: bash, cmd: bash, console: bash,
  yaml, yml: yaml,
  http, rest: http,
};

const LABELS = {
  csharp: 'C#', cs: 'C#', sql: 'SQL', tsql: 'T-SQL', json: 'JSON', js: 'JavaScript', javascript: 'JavaScript',
  ts: 'TypeScript', typescript: 'TypeScript', xml: 'XML', html: 'HTML', csproj: 'csproj', razor: 'Razor',
  cshtml: 'Razor', bash: 'Bash', sh: 'Shell', powershell: 'PowerShell', ps1: 'PowerShell', pwsh: 'PowerShell',
  yaml: 'YAML', yml: 'YAML', http: 'HTTP', cmd: 'CMD', console: 'Console', text: 'Text',
};

export function langLabel(lang) {
  const l = String(lang || 'text').toLowerCase();
  return LABELS[l] || l.toUpperCase();
}

export function highlight(code, lang) {
  const fn = LANGS[String(lang || '').toLowerCase()];
  return fn ? fn(code) : escapeHtml(code);
}
