/**
 * Cross-file resolver: turns T2.1's raw imports, calls, class bases and markdown mentions into edges with a confidence.
 *
 * Called from: `apps/worker/src/graph` (rebuild job). Why it exists: spec:285 says a call is EXTRACTED only when an import edge
 * proves the target, everything else is INFERRED (by tier) or AMBIGUOUS. Pure: the caller hands over the extracted files, the stored
 * nodes of every other file, the resolution file list and the parsed package.json files; nothing is read from disk.
 * Deliberately NOT done: tsconfig `paths`, node_modules lookup, type-based receiver inference, `ctx:`/capability nodes (T2.3), I/O.
 * Untrusted: every field of the input (junk entries are skipped, nothing throws, the input is never modified).
 */
import { createHash } from 'node:crypto';
import { fileStem, langOf, makeId } from './ids.ts';
import { limits } from './types.ts';
import type { ExtractResult, RawImport, RawMention, RawRef } from './types.ts';

/** Read at call time (a test assigns and restores). Both chosen by judgment (DECISIONS D2). */
export const resolveLimits = { maxAmbiguous: 5, maxReexportHops: 5 };

/** FROM-SPEC (spec:266, spec:285): the ranking weights; `ambiguous` equals its ranking weight (judgment). */
export const SCORES = { sameFile: 0.95, samePackage: 0.85, nameOnly: 0.6, ambiguous: 0.3, extracted: 1 } as const;

export type ContextNode = { id: string; type: string; label: string; sourceFile: string | null; meta?: unknown };
export type PackageJson = { dir: string; name: string; exports?: unknown; main?: unknown };
export type Reexport = { specifier: string; names: { imported: string; local: string }[] };
export type ResolveInput = { results: ExtractResult[]; context: ContextNode[]; files: string[]; packages: PackageJson[] };
export type ResolvedEdge = {
  src: string;
  dst: string;
  relation: 'imports' | 'imports_from' | 'calls' | 'inherits' | 'implements' | 'mentions';
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  score: number;
  sourceLocation: string;
};
export type PackageNode = { id: string; kind: 'code'; type: 'package'; label: string; sourceLocation: null; meta: Record<string, never> };
export type ResolveOutput = { edges: Record<string, ResolvedEdge[]>; reexports: Record<string, Reexport[]>; packages: PackageNode[] };

/** sha256 hex of UTF-8(body) followed by UTF-8(relPath); markdown bodies skip the frontmatter (D10). Never throws. */
export function contentHash(relPath: string, content: string): string {
  const path = typeof relPath === 'string' ? relPath : '';
  const text = typeof content === 'string' ? content : '';
  const body = langOf(path) === 'markdown' ? afterFrontmatter(text) : text;
  return createHash('sha256').update(body, 'utf8').update(path, 'utf8').digest('hex');
}

/** The text after the closing line of T2.1's frontmatter (line 1 trimmed is `---`, closed by `---`/`...` within the limit), else all of it. */
function afterFrontmatter(text: string): string {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return text;
  const lastAllowed = Math.min(lines.length, 1 + limits.frontmatterMaxLines);
  let offset = (lines[0] as string).length + 1;
  for (let i = 1; i < lastAllowed; i++) {
    const line = lines[i] as string;
    const t = line.trim();
    offset += line.length + 1;
    if (t === '---' || t === '...') return text.slice(Math.min(offset, text.length));
  }
  return text;
}

type Node = { id: string; type: string; label: string; sourceFile: string };
type Binding = { t: 'sym'; file: string; name: string } | { t: 'mod'; file: string } | { t: 'star'; file: string } | { t: 'ext' };
type Target = { file: string } | { pkg: string } | null;
type Cand = { edge: ResolvedEdge; line: number };

const EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_TO_TS: Record<string, string> = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
const TS_PKG = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const PY_PKG = /^[A-Za-z_]\w*$/;
const REF_TYPES: Record<string, string[]> = {
  call: ['function', 'class'], new: ['class'], jsx: ['function', 'class'], extends: ['class', 'interface', 'type'], implements: ['interface', 'type', 'class'],
};
const MENTION_TYPES = ['function', 'method', 'class', 'interface', 'type', 'variable', 'table'];
const NAMED_TYPES = new Set([...MENTION_TYPES]);
const RANK = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): v is string => typeof v === 'string';
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** POSIX join and normalise; `null` when the path leaves the root. */
function joinNorm(dir: string, rel: string): string | null {
  const out = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

type Family = 'ts' | 'python' | 'bash';
const familyOf = (file: string): Family | null => {
  const l = langOf(file);
  return l === 'ts' || l === 'tsx' || l === 'js' ? 'ts' : l === 'python' ? 'python' : l === 'bash' ? 'bash' : null;
};
/** Name of a symbol node: its label without a leading `.` and a trailing `()`. */
const nameOf = (n: Node): string => n.label.replace(/^\./, '').replace(/\(\)$/, '');

function cleanImport(v: unknown): RawImport | null {
  if (!isObj(v) || !str(v['from']) || !str(v['specifier'])) return null;
  const names = arr(v['names']).filter((n): n is { imported: string; local: string } => isObj(n) && str(n['imported']) && str(n['local']));
  return { from: v['from'], specifier: v['specifier'], names, typeOnly: v['typeOnly'] === true, kind: str(v['kind']) ? (v['kind'] as RawImport['kind']) : 'import', line: typeof v['line'] === 'number' ? v['line'] : 0 };
}
function cleanRef(v: unknown): RawRef | null {
  if (!isObj(v) || !str(v['from']) || !str(v['name']) || !str(v['kind'])) return null;
  return { from: v['from'], name: v['name'], receiver: str(v['receiver']) ? v['receiver'] : null, kind: v['kind'] as RawRef['kind'], line: typeof v['line'] === 'number' ? v['line'] : 0 };
}
function cleanMention(v: unknown): RawMention | null {
  if (!isObj(v) || !str(v['from']) || !str(v['target']) || !str(v['kind'])) return null;
  return { from: v['from'], kind: v['kind'] as RawMention['kind'], target: v['target'], line: typeof v['line'] === 'number' ? v['line'] : 0 };
}

type Clean = { file: string; nodes: Node[]; edges: { src: string; dst: string }[]; imports: RawImport[]; refs: RawRef[]; mentions: RawMention[] };

function cleanResult(r: unknown): Clean | null {
  if (!isObj(r) || !str(r['file']) || r['error'] !== null) return null;
  const file = r['file'];
  const nodes = arr(r['nodes']).flatMap((n): Node[] =>
    isObj(n) && str(n['id']) && str(n['type']) && str(n['label']) ? [{ id: n['id'], type: n['type'], label: n['label'], sourceFile: file }] : [],
  );
  const edges = arr(r['edges']).flatMap((e) => (isObj(e) && e['relation'] === 'contains' && str(e['src']) && str(e['dst']) ? [{ src: e['src'], dst: e['dst'] }] : []));
  const take = <T>(v: unknown, f: (x: unknown) => T | null): T[] => arr(v).flatMap((x) => { const c = f(x); return c ? [c] : []; });
  return { file, nodes, edges, imports: take(r['imports'], cleanImport), refs: take(r['refs'], cleanRef), mentions: take(r['mentions'], cleanMention) };
}

function cleanReexports(meta: unknown): Reexport[] {
  if (!isObj(meta)) return [];
  return arr(meta['reexports']).flatMap((r): Reexport[] => {
    if (!isObj(r) || !str(r['specifier'])) return [];
    const names = arr(r['names']).filter((n): n is { imported: string; local: string } => isObj(n) && str(n['imported']) && str(n['local']));
    return [{ specifier: r['specifier'], names }];
  });
}

/**
 * Resolves every raw import, ref and mention of `input.results` against the node universe (result nodes plus the context nodes of
 * other files). Returns edges per result file (only edges whose `src` is a node of that file, never `contains`), the re-export lists to
 * store on the file nodes and the package nodes the edges point at. Never throws; the same input gives a deep-equal output.
 */
export function resolveGraph(input: ResolveInput): ResolveOutput {
  const inp: Record<string, unknown> = isObj(input) ? input : {};
  const cleaned = arr(inp['results']).flatMap((r) => { const c = cleanResult(r); return c ? [c] : []; });
  const resultFiles = new Set(cleaned.map((c) => c.file));
  const files = new Set(arr(inp['files']).filter(str));
  const packages = arr(inp['packages']).flatMap((p) =>
    isObj(p) && str(p['dir']) && str(p['name']) ? [{ dir: p['dir'], name: p['name'], exports: p['exports'], main: p['main'] }] : [],
  );
  const max = resolveLimits.maxAmbiguous;

  // ---- node universe ---------------------------------------------------------------------------------------------
  const byId = new Map<string, Node>();
  const fileNode = new Map<string, Node>();
  const metaOf = new Map<string, unknown>();
  const named = new Map<string, Node[]>();
  const add = (n: Node, meta: unknown): void => {
    if (byId.has(n.id)) return;
    byId.set(n.id, n);
    if (n.type === 'file' || n.type === 'page') {
      fileNode.set(n.sourceFile, n);
      metaOf.set(n.sourceFile, meta);
    }
    if (NAMED_TYPES.has(n.type) && n.id.startsWith('code:')) {
      const k = nameOf(n);
      const l = named.get(k);
      if (l) l.push(n);
      else named.set(k, [n]);
    }
  };
  for (const c of cleaned) for (const n of c.nodes) add(n, undefined);
  for (const n of arr(inp['context'])) {
    if (!isObj(n) || !str(n['id']) || !str(n['type']) || !str(n['label']) || !str(n['sourceFile']) || resultFiles.has(n['sourceFile'])) continue;
    add({ id: n['id'], type: n['type'], label: n['label'], sourceFile: n['sourceFile'] }, n['meta']);
  }
  const fileId = (f: string): string | null => fileNode.get(f)?.id ?? null;

  // ---- packages (same package = nearest directory with package.json or pyproject.toml) ----------------------------------
  const manifestDirs = new Set<string>();
  for (const f of files) if (baseOf(f) === 'package.json' || baseOf(f) === 'pyproject.toml') manifestDirs.add(dirOf(f));
  const pkgDirCache = new Map<string, string>();
  const pkgDirOf = (f: string): string => {
    let d = dirOf(f);
    const hit = pkgDirCache.get(d);
    if (hit !== undefined) return hit;
    const start = d;
    for (;;) {
      if (manifestDirs.has(d) || d === '') break;
      d = dirOf(d);
    }
    pkgDirCache.set(start, d);
    return d;
  };

  // ---- specifier resolution (D11) ---------------------------------------------------------------------------------------
  const probe = (p: string): string | null => {
    const ext = /\.(?:js|jsx|mjs|cjs)$/.exec(p)?.[0];
    if (ext) {
      const alt = p.slice(0, -ext.length) + (JS_TO_TS[ext] as string);
      if (files.has(alt)) return alt;
    }
    if (p !== '' && files.has(p)) return p;
    if (p !== '') for (const e of EXTS) if (files.has(p + e)) return p + e;
    for (const e of EXTS) {
      const q = p === '' ? `index${e}` : `${p}/index${e}`;
      if (files.has(q)) return q;
    }
    return null;
  };

  const exportTarget = (value: unknown): string | null => {
    if (str(value)) return value;
    if (isObj(value)) {
      if (str(value['import'])) return value['import'];
      if (str(value['default'])) return value['default'];
    }
    return null;
  };
  const exportsLookup = (exp: unknown, sub: string): string | null => {
    if (str(exp)) return sub === '.' ? exp : null;
    if (!isObj(exp)) return null;
    const keys = Object.keys(exp);
    if (!keys.some((k) => k.startsWith('.'))) return sub === '.' ? exportTarget(exp) : null;
    if (Object.hasOwn(exp, sub)) return exportTarget(exp[sub]);
    for (const k of keys.sort(byCode)) {
      const star = k.indexOf('*');
      if (star < 0 || k.indexOf('*', star + 1) >= 0) continue;
      const pre = k.slice(0, star);
      const post = k.slice(star + 1);
      if (sub.length >= k.length - 1 && sub.startsWith(pre) && sub.endsWith(post)) {
        const target = exportTarget(exp[k]);
        return target === null ? null : target.replace('*', sub.slice(pre.length, sub.length - post.length));
      }
    }
    return null;
  };
  const workspace = (name: string, sub: string): string | null => {
    for (const p of packages) {
      if (p.name !== name) continue;
      const entry = exportsLookup(p.exports, sub === '' ? '.' : `.${sub}`);
      if (entry !== null) {
        const joined = joinNorm(p.dir, entry);
        const hit = joined === null ? null : probe(joined);
        if (hit) return hit;
      }
      if (sub === '') {
        if (str(p.main)) {
          const joined = joinNorm(p.dir, p.main);
          const hit = joined === null ? null : probe(joined);
          if (hit) return hit;
        }
        for (const d of ['', 'src']) {
          const joined = joinNorm(p.dir, d);
          const hit = joined === null ? null : [...EXTS].map((e) => (joined === '' ? `index${e}` : `${joined}/index${e}`)).find((q) => files.has(q));
          if (hit) return hit;
        }
      }
    }
    return null;
  };
  const tsSpecifier = (from: string, spec: string): Target => {
    if (spec === '' || spec.includes('://') || spec.startsWith('/')) return null;
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const joined = joinNorm(dirOf(from), spec);
      const hit = joined === null ? null : probe(joined);
      return hit ? { file: hit } : null;
    }
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
    const sub = spec.slice(name.length);
    const wsHit = workspace(name, sub);
    if (wsHit) return { file: wsHit };
    const bare = name.startsWith('node:') ? name.slice(5) : name;
    return TS_PKG.test(bare) ? { pkg: name } : null;
  };

  // python: a module `a/b` lives at `<P>a/b.py` or `<P>a/b/__init__.py`, P = '' or a directory without `__init__.py`
  let pyIndex: Map<string, { prefix: string; file: string }[]> | null = null;
  const pyFiles = (): Map<string, { prefix: string; file: string }[]> => {
    if (pyIndex) return pyIndex;
    const idx = new Map<string, { prefix: string; file: string }[]>();
    for (const f of files) {
      if (!f.endsWith('.py')) continue;
      const segs = f.split('/');
      for (let i = 0; i < segs.length; i++) {
        const prefix = segs.slice(0, i).join('/');
        if (prefix !== '' && files.has(`${prefix}/__init__.py`)) continue;
        const key = segs.slice(i).join('/');
        const l = idx.get(key);
        if (l) l.push({ prefix, file: f });
        else idx.set(key, [{ prefix, file: f }]);
      }
    }
    pyIndex = idx;
    return idx;
  };
  const pyModule = (rest: string): string | null => {
    const path = rest.split('.').join('/');
    const found = [...(pyFiles().get(`${path}.py`) ?? []), ...(pyFiles().get(`${path}/__init__.py`) ?? [])];
    found.sort((a, b) => a.prefix.length - b.prefix.length || byCode(a.prefix, b.prefix));
    return found[0]?.file ?? null;
  };
  /** Directory a python relative import starts from: `.` = the importing file's directory, each further dot one level up; `null` above the root. */
  const pyRelDir = (from: string, dots: number): string | null => {
    let dir: string | null = dirOf(from);
    for (let i = 1; i < dots && dir !== null; i++) dir = dir === '' ? null : dirOf(dir);
    return dir;
  };
  const pySpecifier = (from: string, spec: string): Target => {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots);
    if (dots > 0) {
      const dir = pyRelDir(from, dots);
      if (dir === null) return null;
      const joined = joinNorm(dir, rest.split('.').join('/'));
      if (joined === null) return null;
      for (const c of rest === '' ? [`${dir === '' ? '' : `${dir}/`}__init__.py`] : [`${joined}.py`, `${joined}/__init__.py`]) if (files.has(c)) return { file: c };
      return null;
    }
    const hit = pyModule(rest);
    if (hit) return { file: hit };
    const first = rest.split('.')[0] as string;
    return PY_PKG.test(first) ? { pkg: first } : null;
  };
  const bashSpecifier = (from: string, spec: string): Target => {
    if (spec === '' || spec.includes('://')) return null;
    for (const base of [dirOf(from), '']) {
      const joined = joinNorm(base, spec);
      if (joined !== null && joined !== '' && files.has(joined)) return { file: joined };
    }
    return null;
  };
  const specifier = (from: string, spec: string): Target => {
    const fam = familyOf(from);
    return fam === 'ts' ? tsSpecifier(from, spec) : fam === 'python' ? pySpecifier(from, spec) : fam === 'bash' ? bashSpecifier(from, spec) : null;
  };

  // ---- re-exports and the import proof (D12) -----------------------------------------------------------------------------
  const rawReexports = new Map<string, Reexport[]>();
  for (const c of cleaned) {
    const fam = familyOf(c.file);
    const list = c.imports
      .filter((i) => (fam === 'python' ? true : fam === 'ts' ? i.kind === 'reexport' : false))
      .map((i) => ({ specifier: i.specifier, names: i.names }));
    if (list.length > 0) rawReexports.set(c.file, list);
  }
  const reexportsOf = (f: string): Reexport[] => rawReexports.get(f) ?? (resultFiles.has(f) ? [] : cleanReexports(metaOf.get(f)));
  const symbolNode = (file: string, name: string, types: string[]): Node | null => {
    const n = byId.get(`code:${makeId(fileStem(file), name)}`);
    return n && n.sourceFile === file && types.includes(n.type) ? n : null;
  };
  const prove = (file: string, name: string, types: string[], hops = 0, seen = new Set<string>()): Node | null => {
    const direct = symbolNode(file, name, types);
    if (direct) return direct;
    const key = `${file}\0${name}`;
    if (hops >= resolveLimits.maxReexportHops || seen.has(key)) return null;
    seen.add(key);
    for (const re of reexportsOf(file)) {
      const t = specifier(file, re.specifier);
      if (!t || !('file' in t)) continue;
      for (const n of re.names) {
        const next = n.local === name && n.imported !== '*' ? n.imported : n.imported === '*' && n.local === '*' ? name : null;
        if (next === null) continue;
        const hit = prove(t.file, next, types, hops + 1, seen);
        if (hit) return hit;
      }
    }
    return null;
  };

  // ---- per file ------------------------------------------------------------------------------------------------------------
  const edgesOut = new Map<string, ResolvedEdge[]>();
  const reexportsOut = new Map<string, Reexport[]>();
  const pkgIds = new Map<string, string>();

  for (const c of cleaned) {
    try {
      const own = new Set(c.nodes.map((n) => n.id));
      const cands = new Map<string, Cand>();
      const push = (e: ResolvedEdge, line: number): void => {
        if (!own.has(e.src) || e.src === e.dst) return;
        const key = `${e.src}\0${e.dst}\0${e.relation}`;
        const old = cands.get(key);
        const better =
          !old ||
          RANK[e.confidence] > RANK[old.edge.confidence] ||
          (RANK[e.confidence] === RANK[old.edge.confidence] && (e.score > old.edge.score || (e.score === old.edge.score && line < old.line)));
        if (better) cands.set(key, { edge: e, line });
      };
      const extracted = (src: string, dst: string, relation: ResolvedEdge['relation'], line: number): void =>
        push({ src, dst, relation, confidence: 'EXTRACTED', score: SCORES.extracted, sourceLocation: `L${line}` }, line);
      const fam = familyOf(c.file);
      const reexp = rawReexports.get(c.file);
      if (reexp) reexportsOut.set(c.file, reexp);

      // imports and bindings
      const bindings = new Map<string, Binding>();
      const stars: string[] = [];
      for (const imp of c.imports) {
        const t = specifier(c.file, imp.specifier);
        const relation = imp.names.some((n) => n.imported !== '*') ? 'imports_from' : 'imports';
        const bindExt = (): void => {
          for (const n of imp.names) {
            if (n.local === '*' || bindings.has(n.local)) continue;
            bindings.set(n.local, { t: 'ext' });
            if (n.local.includes('.')) bindings.set(n.local.split('.')[0] as string, { t: 'ext' });
          }
        };
        if (!t) {
          const bare = fam === 'python' && /^\.+$/.test(imp.specifier) ? pyRelDir(c.file, imp.specifier.length) : null;
          for (const n of bare === null ? [] : imp.names) {
            const at = `${bare === '' ? '' : `${bare}/`}${n.imported}`;
            const sub = [`${at}.py`, `${at}/__init__.py`].find((q) => files.has(q));
            const subId = sub ? fileId(sub) : null;
            if (sub && subId) {
              bindings.set(n.local, { t: 'mod', file: sub });
              extracted(imp.from, subId, 'imports_from', imp.line);
            }
          }
          if (imp.kind !== 'reexport') bindExt();
          continue;
        }
        if ('pkg' in t) {
          const id = `code:pkg:${t.pkg}`;
          pkgIds.set(id, t.pkg);
          extracted(imp.from, id, relation, imp.line);
          if (imp.kind !== 'reexport') bindExt();
          continue;
        }
        const target = fileId(t.file);
        if (target) extracted(imp.from, target, relation, imp.line);
        if (imp.kind === 'reexport') continue;
        if (imp.names.length === 0 && fam === 'bash') stars.push(t.file);
        for (const n of imp.names) {
          if (fam === 'python') {
            if (n.imported === '*' && n.local === '*') stars.push(t.file);
            else if (n.imported === '*') bindings.set(n.local, { t: 'mod', file: t.file });
            else {
              const topLevel = byId.get(`code:${makeId(fileStem(t.file), n.imported)}`);
              const dir = dirOf(t.file);
              const sub = baseOf(t.file) === '__init__.py' && !(topLevel && topLevel.sourceFile === t.file)
                ? [`${dir === '' ? '' : `${dir}/`}${n.imported}.py`, `${dir === '' ? '' : `${dir}/`}${n.imported}/__init__.py`].find((p) => files.has(p))
                : undefined;
              if (sub) {
                bindings.set(n.local, { t: 'mod', file: sub });
                const subId = fileId(sub);
                if (subId) extracted(imp.from, subId, 'imports_from', imp.line);
              } else bindings.set(n.local, { t: 'sym', file: t.file, name: n.imported });
            }
          } else if (n.imported === 'default') bindings.set(n.local, { t: 'sym', file: t.file, name: n.local });
          else if (n.imported === '*') {
            if (n.local === '*') stars.push(t.file);
            else bindings.set(n.local, { t: 'mod', file: t.file });
          } else bindings.set(n.local, { t: 'sym', file: t.file, name: n.imported });
        }
      }

      // enclosing classes (contains edges of this result)
      const parent = new Map<string, string>();
      for (const e of c.edges) parent.set(e.dst, e.src);
      const nodeById = new Map(c.nodes.map((n) => [n.id, n]));
      const enclosingClass = (id: string): Node | null => {
        for (let cur = parent.get(id), i = 0; cur !== undefined && i < 1000; cur = parent.get(cur), i++) {
          const n = nodeById.get(cur);
          if (n?.type === 'class') return n;
        }
        return null;
      };

      for (const ref of c.refs) {
        if (!own.has(ref.from) || !Object.hasOwn(REF_TYPES, ref.kind)) continue;
        const relation = ref.kind === 'extends' ? 'inherits' : ref.kind === 'implements' ? 'implements' : 'calls';
        const types = fam === 'bash' ? ['function'] : (REF_TYPES[ref.kind] as string[]);
        const proven = ((): Node | 'external' | null => {
          if (ref.receiver === null) {
            const b = bindings.get(ref.name);
            if (b?.t === 'ext') return 'external';
            if (b?.t === 'sym') {
              const hit = prove(b.file, b.name, types);
              if (hit) return hit;
            } else if (!b) {
              for (const s of stars) {
                const hit = prove(s, ref.name, types);
                if (hit) return hit;
              }
            }
            return null;
          }
          const head = ref.receiver.split('.')[0] as string;
          if (bindings.get(head)?.t === 'ext') return 'external';
          const b = bindings.get(ref.receiver);
          if (b?.t === 'mod') return prove(b.file, ref.name, types);
          if (b?.t === 'sym') {
            const k = prove(b.file, b.name, ['class']);
            const m = k ? byId.get(`code:${makeId(fileStem(k.sourceFile), nameOf(k), ref.name)}`) : undefined;
            return m && m.type === 'method' ? m : null;
          }
          return null;
        })();
        if (proven === 'external') continue;
        if (proven) {
          extracted(ref.from, proven.id, relation, ref.line);
          continue;
        }
        // D13 tiers
        const self = ref.receiver === 'this' || ref.receiver === 'self' || ref.receiver === 'cls';
        if (self) {
          const cls = enclosingClass(ref.from);
          const ms = cls ? c.nodes.filter((n) => n.type === 'method' && nameOf(n) === ref.name && parent.get(n.id) === cls.id) : [];
          if (ms.length === 1) {
            push({ src: ref.from, dst: (ms[0] as Node).id, relation, confidence: 'INFERRED', score: SCORES.sameFile, sourceLocation: `L${ref.line}` }, ref.line);
            continue;
          }
        }
        const allowed = ref.receiver !== null ? ['method'] : types;
        const pool = (named.get(ref.name) ?? []).filter(
          (n) => allowed.includes(n.type) && familyOf(n.sourceFile) === fam && !(fam === 'bash' && n.label === `${baseOf(n.sourceFile)} script`),
        );
        const myPkg = pkgDirOf(c.file);
        const tiers: [Node[], number][] = [
          [pool.filter((n) => n.sourceFile === c.file), SCORES.sameFile],
          [pool.filter((n) => fam !== 'bash' && pkgDirOf(n.sourceFile) === myPkg), SCORES.samePackage],
          [pool, SCORES.nameOnly],
        ];
        for (const [hits, score] of fam === 'bash' ? tiers.slice(0, 1) : ref.receiver !== null ? tiers.slice(0, 2) : tiers) {
          if (hits.length === 0) continue;
          if (hits.length === 1) push({ src: ref.from, dst: (hits[0] as Node).id, relation, confidence: 'INFERRED', score, sourceLocation: `L${ref.line}` }, ref.line);
          else if (hits.length <= max) {
            for (const h of hits) push({ src: ref.from, dst: h.id, relation, confidence: 'AMBIGUOUS', score: SCORES.ambiguous, sourceLocation: `L${ref.line}` }, ref.line);
          }
          break;
        }
      }

      // markdown mentions (D14)
      for (const m of c.mentions) {
        if (!own.has(m.from)) continue;
        const mdDir = dirOf(c.file);
        const linked = (t: string): string | null => {
          const p = joinNorm(t.startsWith('/') ? '' : mdDir, t);
          return p === null ? null : fileId(p);
        };
        if (m.kind === 'link') {
          let decoded = '';
          try {
            decoded = decodeURIComponent(m.target);
          } catch {
            decoded = m.target;
          }
          const dst = linked(m.target) ?? linked(decoded);
          if (dst) extracted(m.from, dst, 'mentions', m.line);
        } else if (m.kind === 'path_symbol') {
          const [p, ...rest] = m.target.split('::');
          if (!p || rest.length === 0) continue;
          const paths = [joinNorm('', p), joinNorm(mdDir, p)].filter((x): x is string => x !== null);
          const sym = paths.map((x) => byId.get(`code:${makeId(fileStem(x), ...rest)}`)).find((n) => n !== undefined);
          const dst = sym?.id ?? paths.map((x) => fileId(x)).find((x) => x !== null);
          if (dst) extracted(m.from, dst, 'mentions', m.line);
        } else if (m.kind === 'symbol') {
          const segs = m.target.split('.');
          const last = segs[segs.length - 1] as string;
          let hits = (named.get(last) ?? []).filter((n) => MENTION_TYPES.includes(n.type));
          if (segs.length > 1) {
            const suffix = `_${makeId(...segs)}`;
            const narrowed = hits.filter((n) => n.id.endsWith(suffix));
            if (narrowed.length > 0) hits = narrowed;
          }
          if (hits.length === 1) push({ src: m.from, dst: (hits[0] as Node).id, relation: 'mentions', confidence: 'INFERRED', score: SCORES.nameOnly, sourceLocation: `L${m.line}` }, m.line);
          else if (hits.length >= 2 && hits.length <= max) {
            for (const h of hits) push({ src: m.from, dst: h.id, relation: 'mentions', confidence: 'AMBIGUOUS', score: SCORES.ambiguous, sourceLocation: `L${m.line}` }, m.line);
          }
        }
      }

      edgesOut.set(c.file, [...cands.values()].map((x) => x.edge).sort((a, b) => byCode(a.src, b.src) || byCode(a.relation, b.relation) || byCode(a.dst, b.dst)));
    } catch {
      // judgment: a file whose resolution throws gets no edges (a missing edge is safer than a wrong EXTRACTED one)
      edgesOut.set(c.file, []);
    }
  }
  for (const c of cleaned) if (!edgesOut.has(c.file)) edgesOut.set(c.file, []);

  const used = new Set<string>();
  for (const list of edgesOut.values()) for (const e of list) if (pkgIds.has(e.dst)) used.add(e.dst);
  const packagesOut: PackageNode[] = [...used]
    .sort(byCode)
    .map((id) => ({ id, kind: 'code', type: 'package', label: pkgIds.get(id) as string, sourceLocation: null, meta: {} }));
  return { edges: Object.fromEntries(edgesOut), reexports: Object.fromEntries(reexportsOut), packages: packagesOut };
}
