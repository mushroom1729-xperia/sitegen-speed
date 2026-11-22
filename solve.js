const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const AMP = '&';
const ESC_MAP = { '&': AMP + 'amp;', '<': AMP + 'lt;', '>': AMP + 'gt;', '"': AMP + 'quot;', "'": AMP + '#39;' };

function escapeHtml(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return text;
  let out = text.slice(0, i) + ESC_MAP[text[i]];
  for (let j = i + 1; j < n; j++) out += ESC_MAP[text[j]] ?? text[j];
  return out;
}

const SLUG_MAX = 64;
const slugCache = new Map();

function computeSlug(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = computeSlug(text);
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, out);
  return out;
}

function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function wordsOf(text) {
  let count = 0;
  let inWord = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

function isSpaceTabOnly(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDateStr(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function isLayoutName(raw) {
  if (raw === '') return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugStr(s) {
  const n = s.length;
  let i = 0;
  for (;;) {
    const start = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
      else break;
    }
    if (i === start) return false;
    if (i === n) return true;
    if (s.charCodeAt(i) !== 45) return false;
    i++;
  }
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    const last = raw.length - 1;
    for (let i = 1; i < last; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === last) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDateStr(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (let t of parts) {
        t = t.trim();
        let bad = t === '';
        if (!bad) {
          for (let i = 0; i < t.length; i++) {
            const c = t.charCodeAt(i);
            if (c === 34 || c === 91 || c === 93) {
              bad = true;
              break;
            }
          }
        }
        if (bad) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return isLayoutName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return raw.length <= 64 && isSlugStr(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
  }
}

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { error: 'no front matter' };
  const n = text.length;
  if (n !== 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let lineStart = n === 3 ? n : 4;
  let closeStart = -1;
  let closeNl = -1;
  while (lineStart <= n) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd - lineStart === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      closeStart = lineStart;
      closeNl = nl;
      break;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = n === 3 ? n : 4;
  let lineNo = 1;
  while (ls < closeStart) {
    const nl = text.indexOf('\n', ls);
    const le = nl === -1 ? n : nl;
    const line = text.slice(ls, le);
    if (!isSpaceTabOnly(line) && line.charCodeAt(0) !== 35) {
      const len = line.length;
      let j = 0;
      while (j < len) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      let raw;
      if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${lineNo + 1} is not "key: value"` };
      else if (j + 1 === len) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      else return { error: `line ${lineNo + 1} is not "key: value"` };
      if (raw !== '') {
        let e = raw.length;
        while (e > 0) {
          const c = raw.charCodeAt(e - 1);
          if (c === 32 || c === 9) e--;
          else break;
        }
        if (e !== raw.length) raw = raw.slice(0, e);
      }
      const key = line.slice(0, j);
      if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    lineNo++;
    ls = le + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// ---------------------------------------------------------------- markdown

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isSpaceTabTail(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (!isSpaceTabTail(line, i)) return null;
  return line.slice(3, i);
}

function isFenceClose(line) {
  return line.length >= 3 && line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && isSpaceTabTail(line, 3);
}

function headingOf(line) {
  const n = line.length;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  let j = k;
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else break;
  }
  if (j === k) return null;
  let b = n;
  while (b > j) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  if (b === j) return null;
  return { depth: k, text: line.slice(j, b) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.length < 3) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  return isSpaceTabTail(line, 3);
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

function orderedOf(line) {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46) return null;
  if (line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), end: i + 2 };
}

function isContinued(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= n) return false;
  return !isWsCode(line.charCodeAt(i));
}

function isEscapable(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

function findUnescapedCh(s, ch, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === ch) return j;
  }
  return -1;
}

function findUnescaped2(s, from, end) {
  for (let j = from; j <= end - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function hasWs(target) {
  for (let i = 0; i < target.length; i++) if (isWsCode(target.charCodeAt(i))) return true;
  return false;
}

function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91) break;
      j++;
    }
    if (j > i) out += escapeHtml(s.slice(i, j));
    if (j === n) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j2 = s.indexOf('`', i + 1);
      if (j2 > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j2))}</code>`;
        i = j2 + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j2 = findUnescaped2(s, i + 2, s.length);
        if (j2 > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j2), env)}</strong>`;
          i = j2 + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j2 = findSingleStar(s, i + 1, s.length);
      if (j2 > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j2), env)}</em>`;
        i = j2 + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    const k = findUnescapedCh(s, 93, i + 1, s.length);
    let m = -1;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWs(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const L = lines.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let out = '';
  let i = 0;
  while (i < L) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let code = '';
        while (i < L && !isFenceClose(lines[i])) code += `${escapeHtml(lines[i++])}\n`;
        i++;
        out += lang === '' ? `<pre><code>${code}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>\n`;
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        i++;
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, env);
        out += `<h${h.depth} id="${id}">${html}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        i++;
        out += '<hr>\n';
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const items = [trimLine(line.slice(2))];
        i++;
        while (i < L) {
          const l = lines[i];
          const lc = l.charCodeAt(0);
          if ((lc === 45 || lc === 42) && l.charCodeAt(1) === 32) {
            items.push(trimLine(l.slice(2)));
            i++;
            continue;
          }
          if (isContinued(l)) {
            items[items.length - 1] += `\n${trimLine(l)}`;
            i++;
            continue;
          }
          break;
        }
        let li = '';
        for (const item of items) li += `<li>${inline(item, env)}</li>\n`;
        out += `<ul>\n${li}</ul>\n`;
        continue;
      }
    }
    if (c0 >= 48 && c0 <= 57) {
      const d = orderedOf(line);
      if (d !== null) {
        const start = d.num;
        const items = [trimLine(line.slice(d.end))];
        i++;
        while (i < L) {
          const l = lines[i];
          const dd = orderedOf(l);
          if (dd !== null) {
            items.push(trimLine(l.slice(dd.end)));
            i++;
            continue;
          }
          if (isContinued(l)) {
            items[items.length - 1] += `\n${trimLine(l)}`;
            i++;
            continue;
          }
          break;
        }
        let li = '';
        for (const item of items) li += `<li>${inline(item, env)}</li>\n`;
        out += start === 1 ? `<ol>\n${li}</ol>\n` : `<ol start="${start}">\n${li}</ol>\n`;
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      out += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < L && !endsParagraph(lines[i])) text += `\n${trimLine(lines[i++])}`;
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaceTabOnly(src.slice(lineStart, open)) && isSpaceTabOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function lookup1(scope, k) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, k)) s = s.parent;
  return s === null ? undefined : s.vars[k];
}

function lookup(scope, path) {
  let s = scope;
  const k = path[0];
  while (s !== null && !Object.hasOwn(s.vars, k)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[k];
  for (let i = 1; i < path.length; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[i])) return undefined;
    v = v[path[i]];
  }
  return v;
}

function compileNodes(nodes, templates) {
  const fns = [];
  let buf = null;
  for (const n of nodes) {
    if (n.kind === 'text') {
      buf = buf === null ? n.text : buf + n.text;
      continue;
    }
    if (buf !== null) {
      const t = buf;
      fns.push(() => t);
      buf = null;
    }
    if (n.kind === 'text') continue;
    switch (n.kind) {
      case 'var':
      case 'raw': {
        const raw = n.kind === 'raw';
        const path = n.path;
        if (path.length === 1) {
          const k = path[0];
          fns.push(raw ? (scope) => textOf(lookup1(scope, k)) : (scope) => escapeHtml(textOf(lookup1(scope, k))));
        } else {
          fns.push(raw ? (scope) => textOf(lookup(scope, path)) : (scope) => escapeHtml(textOf(lookup(scope, path))));
        }
        break;
      }
      case 'if': {
        const thenFn = compileNodes(n.then, templates);
        const elseFn = n.else === null ? null : compileNodes(n.else, templates);
        const not = n.not;
        const path = n.path;
        if (path.length === 1) {
          const k = path[0];
          fns.push((scope, depth) => {
            if (truthy(lookup1(scope, k)) !== not) return thenFn(scope, depth);
            return elseFn === null ? '' : elseFn(scope, depth);
          });
        } else {
          fns.push((scope, depth) => {
            if (truthy(lookup(scope, path)) !== not) return thenFn(scope, depth);
            return elseFn === null ? '' : elseFn(scope, depth);
          });
        }
        break;
      }
      case 'for': {
        const bodyFn = compileNodes(n.body, templates);
        const name = n.name;
        const path = n.path;
        if (path.length === 1) {
          const k = path[0];
          fns.push((scope, depth) => {
            const xs = lookup1(scope, k);
            if (!Array.isArray(xs)) return '';
            let out = '';
            const len = xs.length;
            for (let idx = 0; idx < len; idx++) {
              const vars = {};
              vars[name] = xs[idx];
              vars.loop = { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len };
              out += bodyFn({ vars, parent: scope }, depth);
            }
            return out;
          });
        } else {
          fns.push((scope, depth) => {
            const xs = lookup(scope, path);
            if (!Array.isArray(xs)) return '';
            let out = '';
            const len = xs.length;
            for (let idx = 0; idx < len; idx++) {
              const vars = {};
              vars[name] = xs[idx];
              vars.loop = { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len };
              out += bodyFn({ vars, parent: scope }, depth);
            }
            return out;
          });
        }
        break;
      }
      case 'include': {
        const nm = n.name;
        fns.push((scope, depth) => {
          const t = templates.get(nm);
          if (t !== undefined && depth < INCLUDE_DEPTH) return t(scope, depth + 1);
          return '';
        });
        break;
      }
    }
  }
  if (buf !== null) {
    const t = buf;
    fns.push(() => t);
  }
  if (fns.length === 1 && fns[0].length === 0) return fns[0];
  return (scope, depth) => {
    let out = '';
    for (let k = 0; k < fns.length; k++) out += fns[k](scope, depth);
    return out;
  };
}

// ---------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function wordCount(s) {
  if (s.words === undefined) s.words = wordsOf(s.body);
  return s.words;
}

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordCount(s) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileNodes(parseTemplate(name, input.templates[name]), templates));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const takenMap = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = takenMap.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      takenMap.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const env = {
      link(target) {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const t = bySource.get(path);
          if (t !== undefined) return `${t.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${spath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const seen = new Set();
    const refs = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = bySlug.get(slug);
      refs.push(tag ?? { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
