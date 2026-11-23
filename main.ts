// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under section 3: its own break, whether it ends with one. */
interface FileText {
  br: string;
  finalBr: boolean;
  lines: string[];
}
function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', finalBr: false, lines: [] };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const lines = text.split(br);
  if (finalBr) lines.pop();
  return { br, finalBr, lines };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

/** Section 5: a line under one matching tier. */
type Tier = 0 | 1 | 2;
function norm(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrences(O: string[], F: string[], tier: Tier, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const o = O.map((l) => norm(l, tier));
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(F[i + j]!, tier) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: Tier; pos: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One hunk/chunk body line. A `\` line marks the line before it (noNL). */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
}
function reindent(line: string, P: string, F: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(P)) return line;
  return F + line.slice(P.length);
}
/** Replace O (ctx+del) at pos by the ops' N, writing context lines as the file's own. */
function applyOps(lines: string[], ops: Op[], tier: Tier, pos: number): string[] {
  const O: string[] = [];
  for (const op of ops) if (op.kind !== 'add') O.push(op.text);
  let P = '';
  let F = '';
  if (tier === 2 && O.length > 0) {
    P = /^([ \t]*)/.exec(O[0]!)![1]!;
    F = /^([ \t]*)/.exec(lines[pos]!)![1]!;
  }
  const out = lines.slice(0, pos);
  let j = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(lines[pos + j]!);
      j++;
    } else if (op.kind === 'del') {
      j++;
    } else {
      out.push(tier === 2 ? reindent(op.text, P, F) : op.text);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** Moves a successful edit performed, for the `R` output line (section 2). */
const MOVES: Array<{ old: string; nw: string }> = [];

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** Section 6: unified diffs. One section is one edit. */
interface Hunk {
  a: number;
  ops: Op[];
}
interface USection {
  oldP?: string;
  oldNull: boolean;
  newP?: string;
  newNull: boolean;
  create: boolean;
  del: boolean;
  gitA?: string;
  gitB?: string;
  hunks: Hunk[];
}
function hunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? parseInt(m[1]!, 10) : null;
}
function bodyToOps(body: string[]): Op[] {
  const ops: Op[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) {
      const prev = ops[ops.length - 1];
      if (prev !== undefined) prev.noNL = true;
      continue;
    }
    if (l === '') ops.push({ kind: 'ctx', text: '', noNL: false });
    else if (l.startsWith(' ')) ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
    else if (l.startsWith('-')) ops.push({ kind: 'del', text: l.slice(1), noNL: false });
    else if (l.startsWith('+')) ops.push({ kind: 'add', text: l.slice(1), noNL: false });
  }
  return ops;
}
/** Apply one section's hunks to a file's text; throws Fail('no-match', path). */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const ops = h.ops;
    const olen = ops.filter((o) => o.kind !== 'add').length;
    const nlen = ops.filter((o) => o.kind !== 'del').length;
    if (olen === 0) {
      const ins = Math.max(0, Math.min(h.a + d, f.lines.length));
      const adds = ops.filter((o) => o.kind === 'add');
      const lastAdd = adds[adds.length - 1];
      if (ins === f.lines.length) f.finalBr = !(lastAdd?.noNL ?? false);
      f.lines.splice(ins, 0, ...adds.map((o) => o.text));
      d += nlen;
      continue;
    }
    const O: string[] = [];
    for (const op of ops) if (op.kind !== 'add') O.push(op.text);
    const found = findTier(O, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + O.length === f.lines.length;
    if (runsToEnd) {
      const lastCtxAdd = [...ops].reverse().find((o) => o.kind === 'ctx' || o.kind === 'add');
      f.finalBr = !(lastCtxAdd?.noNL ?? false);
    }
    f.lines = applyOps(f.lines, ops, found.tier, best);
    d += nlen - olen;
  }
  return joinFile(f);
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  let cur: USection | null = null;
  let inHeader = false;
  const newSection = (gitA?: string, gitB?: string): USection => ({
    oldNull: false,
    newNull: false,
    create: false,
    del: false,
    gitA,
    gitB,
    hunks: [],
  });
  const gitPaths = (l: string): [string, string] | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l.trimEnd());
    return m ? [m[1]!, m[2]!] : null;
  };
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const pathOf = (raw: string): string => raw.split('\t')[0]!.trim();
  while (i < n) {
    const l = lines[i]!;
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.startsWith('diff --git ')) {
        const g = gitPaths(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = newSection(g[0], g[1]);
        inHeader = true;
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        inHeader = true;
        continue;
      }
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        inHeader = false;
        continue;
      }
      if (l.startsWith('diff --git ')) {
        sections.push(cur);
        const g = gitPaths(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        cur = newSection(g[0], g[1]);
        i++;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const oldRaw = pathOf(l.slice(4));
          const newRaw = pathOf(lines[i + 1]!.slice(4));
          cur.oldNull = oldRaw === '/dev/null';
          cur.newNull = newRaw === '/dev/null';
          if (!cur.oldNull) cur.oldP = stripAB(oldRaw);
          if (!cur.newNull) cur.newP = stripAB(newRaw);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur.oldP = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.newP = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkHead(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, ops: bodyToOps(body) });
      continue;
    }
    if (l.startsWith('diff --git ')) {
      sections.push(cur);
      const g = gitPaths(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(g[0], g[1]);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sections.push(cur);
      cur = newSection();
      inHeader = true;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  return sections.map((sec) => {
    const oldPath: string | null = sec.oldNull ? null : sec.oldP ?? sec.gitA ?? null;
    const newPath: string | null = sec.newNull ? null : sec.newP ?? sec.gitB ?? null;
    return (tree: Tree): void => {
      if (sec.create || oldPath === null) {
        if (newPath === null) throw new Fail('unsafe', '/dev/null');
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const fl: string[] = [];
        let lastAddNoNL = false;
        let sawAdd = false;
        for (const h of sec.hunks) {
          for (const op of h.ops) {
            if (op.kind === 'add') {
              fl.push(op.text);
              lastAddNoNL = op.noNL;
              sawAdd = true;
            }
          }
        }
        tree.now.set(newPath, !sawAdd ? '' : fl.join('\n') + (lastAddNoNL ? '' : '\n'));
        return;
      }
      if (sec.del || newPath === null) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(before, sec.hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        MOVES.push({ old: oldPath, nw: newPath });
        return;
      }
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const content = tree.get(oldPath);
      if (content === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyHunks(content, sec.hunks, strict, oldPath));
    };
  });
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let si = -1;
    for (let k = i; k < n; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        si = k;
        break;
      }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = si + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (eq < 0 && t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const f = splitFile(content);
      const found = findTier(oldLines, f.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      let P = '';
      let F = '';
      if (found.tier === 2) {
        P = /^([ \t]*)/.exec(oldLines[0]!)![1]!;
        F = /^([ \t]*)/.exec(f.lines[pos]!)![1]!;
      }
      const repLines = newLines.map((l) => (found.tier === 2 ? reindent(l, P, F) : l));
      f.lines.splice(pos, oldLines.length, ...repLines);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // A section runs from its header line to the next section header (or End
  // Patch). Blank lines at the end of a section are not part of it, so each
  // section is read from its span with trailing empty lines removed.
  const isSection = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < last && !isSection(lines[end]!)) end++;
    let spanEnd = end;
    while (spanEnd > i + 1 && lines[spanEnd - 1] === '') spanEnd--;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const fl: string[] = [];
      for (let j = i + 1; j < spanEnd; j++) {
        const b = lines[j]!;
        if (b === '') fl.push('');
        else if (b.startsWith('+')) fl.push(b.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      const p = path;
      const content = fl;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = end;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      for (let j = i + 1; j < spanEnd; j++) throw new Exit2(`error: parse ${j + 1}`);
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = end;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let moveTo: string | null = null;
      let j = i + 1;
      if (j < spanEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (j < spanEnd) {
        const b = lines[j]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: b.slice(2).trim(), eof: false, ops: [] };
          firstChunk = false;
          j++;
          continue;
        }
        if (b.startsWith('*** End of File')) {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          j++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, ops: [] };
            firstChunk = false;
          }
          if (b === '') cur.ops.push({ kind: 'ctx', text: '', noNL: false });
          else if (b.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: b.slice(1), noNL: false });
          else if (b.startsWith('-')) cur.ops.push({ kind: 'del', text: b.slice(1), noNL: false });
          else cur.ops.push({ kind: 'add', text: b.slice(1), noNL: false });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) {
        // This chunk is still open at the end of the section, so the empty
        // context lines at its end are the section's trailing blank lines
        // and are not part of it. A chunk closed by `*** End of File`
        // keeps its blank lines: they sit before the marker, inside the
        // section, and are real context lines.
        while (cur.ops.length > 0 && cur.ops[cur.ops.length - 1]!.kind === 'ctx' && cur.ops[cur.ops.length - 1]!.text === '') cur.ops.pop();
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitFile(content);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const a = findTier([ch.anchor], f.lines, strict, cursor);
            if (a === null) throw new Fail('no-match', p);
            cursor = a.pos[0]! + 1;
          }
          const O: string[] = [];
          for (const op of ch.ops) if (op.kind !== 'add') O.push(op.text);
          if (O.length === 0) {
            const ins = ch.eof ? f.lines.length : cursor;
            const adds = ch.ops.filter((o) => o.kind === 'add').map((o) => o.text);
            f.lines.splice(ins, 0, ...adds);
            cursor = ins + adds.length;
            continue;
          }
          const found = findTier(O, f.lines, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          let pos: number | null = null;
          for (const q of found.pos) {
            if (ch.eof && q + O.length !== f.lines.length) continue;
            pos = q;
            break;
          }
          if (pos === null) throw new Fail('no-match', p);
          f.lines = applyOps(f.lines, ch.ops, found.tier, pos);
          cursor = pos + ch.ops.filter((o) => o.kind !== 'del').length;
        }
        const out = joinFile(f);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, out);
          MOVES.push({ old: p, nw: mt });
        } else {
          tree.now.set(p, out);
        }
      });
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  MOVES.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
  }
  const moved = new Map<string, string>();
  for (const m of MOVES) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      moved.set(m.old, m.nw);
    }
  }
  const movedNew = new Set(moved.values());
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of changed) {
    if (moved.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [old, nw] of moved) rows.push({ key: nw, text: `R ${old} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
