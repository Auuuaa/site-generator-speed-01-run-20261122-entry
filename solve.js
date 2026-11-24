// Fast drop-in for makefun-site 1.0.0.
//
// Own implementation, written from scratch: it answers exactly as makefun-site
// 1.0.0 does for every case's input, faster. The semantics it implements are
// the ones makefun-site states in its README and runs in its code: the strict
// front matter, the slug rule, the Markdown subset, the template dialect and
// the build report. Nothing here is copied from that code: the control flow,
// the data structures and the hot paths are my own.
//
// Speed notes:
//  - slugify results are memoised per case (titles and tag names repeat a lot).
//  - HTML escaping has a fast path: a string with no escapable character is
//    returned untouched instead of going through a regex replace.
//  - Markdown is rendered in one pass over the source lines: no token objects
//    are built, and inline markup is rendered with bulk plain-text runs
//    instead of one escaped character at a time.
//  - Templates are rendered by a small interpreter over one flat scope
//    object: loop bindings are saved and restored around a loop body instead
//    of allocating a scope object per iteration, and every render pushes its
//    pieces into one shared array that is joined once.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Strings holding none of them are returned as-is. */
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  let out = '';
  let start = 0;
  for (let p = 0; p < text.length; p++) {
    const e = ESCAPES[text[p]];
    if (e !== undefined) {
      out += text.slice(start, p) + e;
      start = p + 1;
    }
  }
  return out + text.slice(start);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. `cache` memoises results inside one case.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
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
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value, or why it is refused. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body lines: { data, lines, bodyStart }, or { error }. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyStart: close + 1 };
}

// --------------------------------------------------------------- templates

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src` split into tokens: text, {{ }}, {{{ }}} and {% %}. A {% %} tag alone
 * on its line takes the whole line with it, its newline included.
 */
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
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
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
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
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the flat scope `vars`: own properties only. */
function lookup(vars, path) {
  if (!Object.hasOwn(vars, path[0])) return undefined;
  let v = vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `parts`, in the flat scope `vars`. Loop bindings are
 * saved on entry and restored on exit, so one scope object serves a whole
 * render and no scope object is allocated per iteration. Each for-node keeps
 * one loop record whose fields are rewritten per iteration.
 */
function renderInto(nodes, vars, ctx, depth, parts) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escapeHtml(textOf(lookup(vars, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(vars, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(vars, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, vars, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(vars, n.path);
        if (!Array.isArray(xs)) break;
        const loop = n.loop ?? (n.loop = { index: 0, first: false, last: false, length: 0 });
        const prevX = vars[n.name];
        const hadX = Object.hasOwn(vars, n.name);
        const prevLoop = vars.loop;
        const hadLoop = Object.hasOwn(vars, 'loop');
        // The record is shared by every activation of this node: save its
        // fields, so a template that includes itself inside its own loop
        // still reads the outer iteration's loop values afterwards.
        const svIndex = loop.index;
        const svFirst = loop.first;
        const svLast = loop.last;
        const svLength = loop.length;
        loop.length = xs.length;
        for (let k = 0; k < xs.length; k++) {
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          vars[n.name] = xs[k];
          vars.loop = loop;
          renderInto(n.body, vars, ctx, depth, parts);
        }
        loop.index = svIndex;
        loop.first = svFirst;
        loop.last = svLast;
        loop.length = svLength;
        if (hadX) vars[n.name] = prevX;
        else vars[n.name] = undefined;
        if (hadLoop) vars.loop = prevLoop;
        else vars.loop = undefined;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (ctx.constant.has(n.name)) {
          // This template reads only site, tags and recent, which do not
          // change inside a case: its render at this depth is the same
          // every time, so render it once and reuse the string.
          const key = `${n.name}\n${depth + 1}`;
          const hit = ctx.constCache.get(key);
          if (hit !== undefined) {
            parts.push(hit);
            break;
          }
          const sub = [];
          renderInto(t, vars, ctx, depth + 1, sub);
          const s = sub.join('');
          ctx.constCache.set(key, s);
          parts.push(s);
          break;
        }
        renderInto(t, vars, ctx, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- markdown

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const trimLine = (line) => line.replace(/^[ \t]+|[ \t]+$/g, '');

/** A heading line's level and text, or null. */
function headingOf(line) {
  if (line[0] !== '#') return null;
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let p = 0; p < line.length; p++) {
    const c = line[p];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === '`') return MD_FENCE_OPEN.test(line);
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return MD_HR.test(line);
  if (c === ' ' || c === '\t') return isBlank(line);
  return false;
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is skipped when the run of backslashes directly
 * before it (counted from `from`) is odd: its last backslash escapes the
 * match's first character.
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let a = k - 1;
    while (a >= from && s[a] === '\\') a--;
    if ((k - 1 - a) % 2 === 0) return k;
    j = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let a = k - 1;
    while (a >= from && s[a] === '\\') a--;
    if ((k - 1 - a) % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s[k + 1] === '*') {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain text is
 * accumulated in runs and escaped in bulk, and the scan jumps from one
 * markup character (`\`, backtick, `*`, `[`) to the next instead of
 * stepping through every character.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  let plain = 0;
  const flush = (end) => {
    if (end > plain) out += escapeHtml(s.slice(plain, end));
  };
  const nextSpecial = (from) => {
    let best = -1;
    let k = s.indexOf('\\', from);
    if (k !== -1) best = k;
    k = s.indexOf('`', from);
    if (k !== -1 && (best === -1 || k < best)) best = k;
    k = s.indexOf('*', from);
    if (k !== -1 && (best === -1 || k < best)) best = k;
    k = s.indexOf('[', from);
    if (k !== -1 && (best === -1 || k < best)) best = k;
    return best;
  };
  for (;;) {
    const k = nextSpecial(i);
    if (k === -1) break;
    const c = s[k];
    if (c === '\\' && k + 1 < s.length && ESCAPABLE.has(s[k + 1])) {
      flush(k);
      out += escapeHtml(s[k + 1]);
      i = k + 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', k + 1);
      if (j > k + 1) {
        flush(k);
        out += `<code>${escapeHtml(s.slice(k + 1, j))}</code>`;
        i = j + 1;
        plain = i;
      } else {
        i = k + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[k + 1] === '*') {
        const j = findUnescaped(s, '**', k + 2);
        if (j > k + 2) {
          flush(k);
          out += `<strong>${inline(s.slice(k + 2, j), env)}</strong>`;
          i = j + 2;
          plain = i;
        } else {
          i = k + 2;
        }
        continue;
      }
      const j = findSingleStar(s, k + 1);
      if (j > k + 1) {
        flush(k);
        out += `<em>${inline(s.slice(k + 1, j), env)}</em>`;
        i = j + 1;
        plain = i;
      } else {
        i = k + 1;
      }
      continue;
    }
    if (c === '[') {
      const kk = findUnescaped(s, ']', k + 1);
      const m = kk !== -1 && s[kk + 1] === '(' ? s.indexOf(')', kk + 2) : -1;
      const target = m === -1 ? '' : s.slice(kk + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(k);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(k + 1, kk), env)}</a>`;
        i = m + 1;
        plain = i;
        continue;
      }
      i = k + 1;
      continue;
    }
    i = k + 1;
  }
  flush(s.length);
  return out;
}

/**
 * `lines` from `start` rendered: its HTML, its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, start, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c = line[0];
    if (c === '`') {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        let code = '';
        for (const l of body) code += `${escapeHtml(l)}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c === '-' || c === '*') {
      if (MD_HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if (l[0] === '-' || l[0] === '*') {
            const m = MD_BULLET.exec(l);
            if (m !== null) {
              items.push([trimLine(m[1])]);
              i++;
              continue;
            }
          }
          if (l[0] === ' ' && MD_CONTINUED.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        blocks.push(`<ul>\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</ul>`);
        continue;
      }
    } else if (c === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c >= '0' && c <= '9') {
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if (l[0] >= '0' && l[0] <= '9') {
            const m = MD_ORDERED.exec(l);
            if (m !== null) {
              items.push([trimLine(m[2])]);
              i++;
              continue;
            }
          }
          if (l[0] === ' ' && MD_CONTINUED.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</ol>`);
        continue;
      }
    } else if (c === ' ' || c === '\t') {
      if (isBlank(line)) {
        i++;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

/**
 * The names each template's render reads that are not bound inside it: for
 * every node, the first segment of its paths, minus the names its enclosing
 * fors bind, plus the free names of the templates it includes (minus the
 * names bound at each include site). Solved by fixpoint iteration, so
 * include cycles are fine. A template whose free names are only site, tags
 * and recent renders the same for every page of a case.
 */
function templateFreeNames(templates) {
  const info = new Map();
  for (const [name, nodes] of templates) {
    const direct = new Set();
    const sites = [];
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) direct.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) direct.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) direct.add(n.path[0]);
          const inner = new Set(bound);
          inner.add(n.name);
          inner.add('loop');
          walk(n.body, inner);
        } else if (n.kind === 'include') {
          sites.push({ name: n.name, bound: new Set(bound) });
        }
      }
    };
    walk(nodes, new Set());
    info.set(name, { direct, sites });
  }
  const free = new Map();
  for (const name of templates.keys()) free.set(name, new Set(info.get(name).direct));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, { sites }] of info) {
      const f = free.get(name);
      for (const s of sites) {
        const sf = free.get(s.name);
        if (sf === undefined) continue;
        for (const v of sf) {
          if (!s.bound.has(v) && !f.has(v)) {
            f.add(v);
            changed = true;
          }
        }
      }
    }
  }
  return free;
}

// ------------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body's lines from `start`: their runs of characters other than whitespace. Counted by hand so no match array is built. */
function wordsOfLines(lines, start) {
  let n = 0;
  for (let li = start; li < lines.length; li++) {
    const text = lines[li];
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const ws = c === 32 || (c >= 9 && c <= 13) || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (ws) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = fm.lines;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
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

  // 3. Permalinks: each page's output directory and url.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: the posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => {
    if (s.readingMinutes === undefined) s.readingMinutes = Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart) / 200));
    return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const vars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const free = templateFreeNames(templates);
  const constant = new Set();
  for (const [name, names] of free) {
    let ok = true;
    for (const v of names) {
      if (v !== 'site' && v !== 'tags' && v !== 'recent') {
        ok = false;
        break;
      }
    }
    if (ok) constant.add(name);
  }
  const ctx = { templates, constant, constCache: new Map() };
  const output = {};
  const render = (name) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderInto(nodes, vars, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of kept) {
    vars.page = pageOf(s);
    vars.posts = undefined;
    vars.pager = undefined;
    vars.tag = undefined;
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    vars.page = undefined;
    vars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    vars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    vars.tag = undefined;
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    vars.page = undefined;
    vars.posts = undefined;
    vars.pager = undefined;
    vars.tag = tagOf(t);
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  vars.page = undefined;
  vars.posts = undefined;
  vars.pager = undefined;
  vars.tag = undefined;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.length - posts.length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
