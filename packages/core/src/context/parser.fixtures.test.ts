import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildExtractPrompt, parseCapability, parseContext, parseExtractReply, resolveRefs } from './index.ts';
import type { ContextParse, CtxNode } from './index.ts';

const DIR = new URL('./__fixtures__/', import.meta.url);
const text = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');
const expected = (name: string) => JSON.parse(text(name)) as Expected;

type ExpNode = { id: string; type?: string; line: number; label?: string; labelStart?: string; value?: string; done?: boolean; parallel?: boolean; lines?: [number, number]; date?: string };
type Expected = {
  path: string;
  spec?: { label: string; line: number; lines: [number, number] };
  nodes: ExpNode[];
  partOf?: string[];
  refs: [string, string, string, string, number][];
};

/** Expected files are typed from DECISIONS D5/D6/D9 and the real documents, never produced by the parser (D21). */
function run(fixture: string, exp: string): { parse: ContextParse; want: Expected; local: (n: CtxNode) => string } {
  const want = expected(exp);
  const parse = parseContext({ path: want.path, content: text(fixture) });
  const stem = want.path.replace(/\.[^./]*$/, '');
  return { parse, want, local: (n) => n.id.slice(`ctx:${stem}:`.length) };
}

function expectNodes({ parse, want, local }: ReturnType<typeof run>): void {
  expect(parse.error).toBeNull();
  const spec = parse.nodes.find((n) => n.type === 'spec');
  if (want.spec) {
    expect(spec?.label).toBe(want.spec.label);
    expect([spec?.sourceLocation, spec?.meta['lines']]).toEqual([`L${want.spec.line}`, want.spec.lines]);
    expect(parse.nodes[0]).toBe(spec);
  } else expect(spec).toBeUndefined();
  const rest = parse.nodes.filter((n) => n.type !== 'spec');
  expect(rest.map(local)).toEqual(want.nodes.map((n) => n.id));
  want.nodes.forEach((w, i) => {
    const n = rest[i] as CtxNode;
    if (w.type) expect(n.type).toBe(w.type);
    expect(n.sourceLocation).toBe(`L${w.line}`);
    if (w.label !== undefined) expect(n.label).toBe(w.label);
    if (w.labelStart !== undefined) expect(n.label.startsWith(w.labelStart)).toBe(true);
    if (w.value !== undefined) expect(n.meta['value']).toBe(w.value);
    if (w.done !== undefined) expect(n.meta['done']).toBe(w.done);
    if (w.parallel !== undefined) expect(n.meta['parallel'] === true).toBe(w.parallel);
    if (w.lines) expect(n.meta['lines']).toEqual(w.lines);
    if (w.date) expect(n.meta['date']).toBe(w.date);
  });
  if (want.partOf) {
    expect(parse.edges.map((e) => local({ id: e.src } as CtxNode))).toEqual([...want.partOf].sort());
    expect(parse.edges.every((e) => e.dst === `ctx:${want.path.replace(/\.[^./]*$/, '')}:spec` && e.relation === 'part_of' && e.confidence === 'EXTRACTED' && e.score === 1)).toBe(true);
  }
  expect(parse.refs.map((r) => [local({ id: r.from } as CtxNode), r.relation, r.kind, r.target, r.line])).toEqual(want.refs);
}

describe('parser fixtures', () => {
  it('007 spec tables', () => {
    const r = run('spec007.md.txt', 'spec007.expected.json');
    expectNodes(r);
    expect(r.parse.nodes.filter((n) => n.type === 'task')).toHaveLength(24);
    expect(r.parse.nodes.filter((n) => n.type === 'decision').map(r.local)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']);
    expect(r.parse.nodes.filter((n) => n.type === 'requirement')).toEqual([]);
    expect(r.parse.nodes.filter((n) => n.type === 'decision').every((n) => !r.parse.edges.some((e) => e.src === n.id))).toBe(true);
  });

  it('checklists and requirements', () => {
    expectNodes(run('spec006.md.txt', 'spec006.expected.json'));
    expectNodes(run('tasks002.md.txt', 'tasks002.expected.json'));
    const s = run('spec002.md.txt', 'spec002.expected.json');
    expectNodes(s);
    const ids = s.parse.nodes.map(s.local);
    expect([ids.filter((i) => i.startsWith('FR-')).length, ids.filter((i) => i.startsWith('SC-')).length, ids.filter((i) => /^US\d$/.test(i)).length]).toEqual([30, 7, 8]);
    const us = (n: number) => s.parse.nodes.find((x) => x.id.endsWith(`:US${n}`))?.meta['priority'];
    expect([us(2), us(4), us(7)]).toEqual(['P1', 'P2', 'P3']);
  });

  it('issue file and CLAUDE.md decisions', () => {
    const issue = run('issue03.md.txt', 'issue03.expected.json');
    const w = issue.want as unknown as { id: string; label: string; status: string; blockedBy: string; lines: [number, number]; line: number; refs: unknown[] };
    const [node] = issue.parse.nodes as [CtxNode];
    expect([issue.parse.nodes.length, issue.parse.edges, issue.local(node), node.type, node.label, node.sourceLocation]).toEqual([1, [], w.id, 'task', w.label, `L${w.line}`]);
    expect([node.meta['status'], node.meta['blockedBy'], node.meta['lines']]).toEqual([w.status, w.blockedBy, w.lines]);
    expect(issue.parse.refs.map((r) => [r.relation, r.kind, r.target, r.line])).toEqual(w.refs);
    expectNodes(run('claude-decisions.md.txt', 'claude-decisions.expected.json'));
  });

  it('fences, duplicates and malformed rows', () => {
    const md = [
      '# Feature Specification: Edge cases', '```', '| T9.9 | in a fence | x |', '- [ ] T9.8 inside', '```', '~~~', '| T9.7 | tilde fence | x |', '~~~',
      '| T1.1 | first wins | x |', '- [x] T1.1 later duplicate', '| Phase | Task | Done when |', '|---|---|---|', '| T2.1', '|', '| | | |', '| T3.1 | | x |', '- [ ] T4.1', '## D5 heading decision',
      '- [ ] not a task', '| T5.1 `a/b.ts::go` and https://x.dev/y/z.html | x |',
    ].join('\n');
    const r = parseContext({ path: 'specs/edge.md', content: md });
    const ids = r.nodes.map((n) => n.id.split(':').pop());
    expect(ids).toEqual(['spec', 'T1.1', 'T2.1', 'T3.1', 'T4.1', 'D5', 'T5.1']);
    expect(r.nodes.find((n) => n.id.endsWith(':T1.1'))?.label).toBe('first wins');
    expect(r.nodes.find((n) => n.id.endsWith(':T3.1'))?.label).toBe('T3.1');
    expect(r.nodes.find((n) => n.id.endsWith(':T4.1'))?.label).toBe('T4.1');
    expect(r.refs.map((x) => `${x.kind}:${x.target}`)).toEqual(['path_symbol:a/b.ts::go']);
    expect(r.error).toBeNull();
    const crlf = parseContext({ path: 'specs/edge.md', content: `﻿${md.replaceAll('\n', '\r\n')}\r\n` });
    expect(crlf.nodes.map((n) => n.id)).toEqual(r.nodes.map((n) => n.id));
  });

  it('refs and resolution', () => {
    const t = parseContext({ path: 'specs/a.md', content: '| T1.1 edit `src/a.ts::run` and src/b.ts and ./lib/c.py::Cls.method see https://e.com/p/q.html | x |\n' });
    expect(t.refs.map((r) => [r.relation, r.kind, r.target])).toEqual([['implements', 'path_symbol', 'src/a.ts::run'], ['implements', 'path', 'src/b.ts'], ['implements', 'path_symbol', 'lib/c.py::Cls']]);
    const n = (id: string, type: string, label: string, sourceFile: string | null) => ({ id, type, label, sourceFile });
    const nodes = [n('code:a', 'file', 'src/a.ts', 'src/a.ts'), n('code:a_run', 'function', 'run()', 'src/a.ts'), n('code:b', 'file', 'src/b.ts', 'src/b.ts'), n('code:c', 'file', 'lib/c.py', 'lib/c.py'),
      n('code:c1', 'method', '.method()', 'lib/c.py'), n('code:syn', 'file', '<packages>', '<packages>')];
    const out = resolveRefs(t.refs, nodes.map((x) => ({ ...x })));
    expect(out.map((e) => [e.dst, e.confidence, e.score])).toEqual([['code:b', 'EXTRACTED', 1], ['code:a_run', 'EXTRACTED', 1], ['code:c', 'INFERRED', 0.6]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    expect(resolveRefs(t.refs, nodes, { inferred: true }).map((e) => e.confidence)).toEqual(['INFERRED', 'INFERRED', 'INFERRED']);
    expect(resolveRefs([{ from: 'x', relation: 'implements', kind: 'path', target: '<packages>', line: 1 }], nodes)).toEqual([]);
  });

  it('capability nodes', () => {
    const skill = parseCapability({ kind: 'skill', name: 'tdd', description: 'Test first', frontmatter: { skills: ['plan'], commands: 'review, ship' }, body: 'Use agent:reviewer and skill:tdd.', servedVersion: 1, bodyHash: 'h' });
    expect(skill.nodes.map((x) => [x.id, x.kind, x.type])).toEqual([['skill:tdd', 'capability', 'skill']]);
    expect(skill.edges.map((e) => [e.src, e.dst, e.relation])).toEqual([['skill:tdd', 'agent:reviewer', 'uses'], ['skill:tdd', 'command:review', 'uses'], ['skill:tdd', 'command:ship', 'uses'], ['skill:tdd', 'skill:plan', 'uses']]);
    const wf = parseCapability({ kind: 'workflow', name: 'ship-it', description: 'd', frontmatter: { nodes: [{ id: 'a', type: 'agent', prompt: 'run skill:tdd' }, { id: 'a' }, { id: 'b c' }, { id: 'b' }] }, body: '', servedVersion: 1, bodyHash: 'h' });
    expect(wf.nodes.map((x) => x.id)).toEqual(['workflow:ship-it', 'workflow:ship-it:a', 'workflow:ship-it:b']);
    expect(wf.edges.map((e) => [e.src, e.dst, e.relation])).toEqual([['workflow:ship-it', 'workflow:ship-it:a', 'contains'], ['workflow:ship-it', 'workflow:ship-it:b', 'contains'], ['workflow:ship-it:a', 'skill:tdd', 'invokes']]);
    expect(parseCapability({ kind: 'skill', name: 'Bad Name', description: '', frontmatter: {}, body: '', servedVersion: null, bodyHash: '' })).toEqual({ nodes: [], edges: [], hash: '' });
  });

  it('extract reply', () => {
    const file = 'specs/x.md';
    const nodes = [{ id: 'ctx:specs/x:T1', type: 'task' }, { id: 'ctx:specs/x:D1', type: 'decision' }];
    const good = '{"edges":[{"from":"T1","relation":"implements","to":"./src/a.ts"},{"from":"D1","relation":"decides","to":"src/b.ts::f"},{"from":"D1","relation":"implements","to":"src/c.ts"}]}';
    const want = { ok: true, edges: [{ src: 'ctx:specs/x:T1', relation: 'implements', kind: 'path', target: 'src/a.ts' }, { src: 'ctx:specs/x:D1', relation: 'decides', kind: 'path_symbol', target: 'src/b.ts::f' }], dropped: 1 };
    expect(parseExtractReply(good, { file, nodes })).toEqual(want);
    expect(parseExtractReply(`\`\`\`json\n${good}\n\`\`\``, { file, nodes })).toEqual(want);
    expect(parseExtractReply(`Here: ${good} done`, { file, nodes })).toEqual(want);
    expect(parseExtractReply('nothing to see', { file, nodes })).toEqual({ ok: false, code: 'bad_reply', message: 'the reply is not a JSON object with an edges array' });
    const prompt = buildExtractPrompt({ file, text: 'doc <private>SECRET</private>', nodes: [{ id: 'ctx:specs/x:T1', type: 'task', label: 'do it' }] });
    expect(prompt.includes('SECRET')).toBe(false);
    expect(prompt.split('\n')).toContain('T1 | task | do it');
    expect(prompt.split('\n').at(-1)).toBe('Reply with JSON only: {"edges":[{"from":"<id>","relation":"implements|decides","to":"<path>[::symbol]"}]}');
  });
});
