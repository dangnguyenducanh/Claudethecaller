import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LABEL_RE, NAME_RE, buildVersion, cosine, diffManifests, isLabel, isName, libraryLimits, parseFrontmatter, peekName, resolveServed,
  sameManifest, sha256Hex, skillretText, type BuildInput,
} from './index.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const md = (name: string, desc: string, body = 'Body\n') => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;
const input = (defaultName: string, files: [string, string | Uint8Array][], kind: BuildInput['kind'] = 'skill', mainPath = 'SKILL.md'): BuildInput => ({
  kind, namespace: 'user', defaultName, rootPath: `/r/${defaultName}`, mainPath,
  files: files.map(([path, b]) => ({ path, bytes: typeof b === 'string' ? enc(b) : b })),
});
const keep = { ...libraryLimits };
afterEach(() => Object.assign(libraryLimits, keep));

describe('limits (D2)', () => {
  it('pins the defaults', () => {
    expect({ ...libraryLimits }).toEqual({ maxFiles: 200, maxBytes: 1048576, maxNameLen: 64, maxDescription: 1024, bodyChars: 8000 });
  });
  it('file count: equal is valid, one more is too_many_files, read at call time', () => {
    libraryLimits.maxFiles = 3;
    const many = (n: number) => buildVersion(input('d', Array.from({ length: n }, (_, i): [string, string] => (i === 0 ? ['SKILL.md', md('d', 'x')] : [`f${i}.md`, 'x']))));
    expect([many(3).ok, (many(4) as { skip?: { code: string } }).skip?.code]).toEqual([true, 'too_many_files']);
  });
  it('bytes: equal is valid, one more is too_large; limits argument overrides', () => {
    const main = md('d', 'x');
    const sized = (n: number) => buildVersion(input('d', [['SKILL.md', main], ['pad.txt', 'p'.repeat(n)]]), { ...libraryLimits, maxBytes: enc(main).length + 5 });
    expect([sized(5).ok, sized(6)]).toEqual([true, expect.objectContaining({ skip: expect.objectContaining({ code: 'too_large' }) })]);
  });
  it('name and description lengths: equal is valid, one more is an error', () => {
    const named = (n: number) => buildVersion(input('d', [['SKILL.md', md('a'.repeat(n), 'x')]]));
    const described = (n: number) => buildVersion(input('d', [['SKILL.md', md('d', 'd'.repeat(n))]]));
    expect([named(64).ok, named(65)]).toEqual([true, expect.objectContaining({ skip: expect.objectContaining({ code: 'bad_name' }) })]);
    expect([described(1024).ok, described(1025)]).toEqual([true, expect.objectContaining({ skip: expect.objectContaining({ code: 'description_too_long' }) })]);
  });
});

describe('names (D9)', () => {
  it('NAME_RE and LABEL_RE are the spec expressions', () => {
    expect([String(NAME_RE), String(LABEL_RE)]).toEqual([String(/^[a-z0-9]+(-[a-z0-9]+)*$/), String(/^[a-z0-9_\-.]{1,36}$/)]);
    expect([isName('tdd-x'), isName('Tdd'), isName('a--b'), isLabel('v1.2_rc-1'), isLabel('a'.repeat(37)), isLabel('Prod')]).toEqual([true, false, false, true, false, false]);
  });
});

describe('parseFrontmatter (D12)', () => {
  it('header, body, BOM, CRLF, empty header, closing line at end of file', () => {
    expect(parseFrontmatter('---\nname: x\ndescription: d\n---\nBody\n')).toEqual({ ok: true, frontmatter: { name: 'x', description: 'd' }, body: 'Body\n' });
    expect(parseFrontmatter('plain')).toEqual({ ok: true, frontmatter: {}, body: 'plain' });
    expect(parseFrontmatter('﻿---\na: 1\n---\nB')).toEqual({ ok: true, frontmatter: { a: 1 }, body: 'B' });
    expect(parseFrontmatter('---\r\na: 1\r\n---\r\nB\r\n')).toEqual({ ok: true, frontmatter: { a: 1 }, body: 'B\r\n' });
    expect(parseFrontmatter('---\n---\nB')).toEqual({ ok: true, frontmatter: {}, body: 'B' });
    expect(parseFrontmatter('---\na: 1\n---')).toEqual({ ok: true, frontmatter: { a: 1 }, body: '' });
  });
  it.each([
    ['alias', '---\na: &x 1\nb: *x\n---\n'],
    ['duplicate key', '---\na: 1\na: 2\n---\n'],
    ['unclosed', '---\na: 1\n'],
    ['list', '---\n- a\n---\n'],
    ['scalar', '---\njust a scalar\n---\n'],
    ['nested mapping in a plain scalar', '---\ndescription: Use it. Triggers on: x\n---\n'],
  ])('%s is bad_yaml with a message that does not echo the file', (_name, text) => {
    const got = parseFrontmatter(text);
    expect(got).toMatchObject({ ok: false, code: 'bad_yaml' });
    expect((got as { message: string }).message).not.toContain('Triggers');
  });
});

describe('buildVersion (D13, D4)', () => {
  it('hashes bytes, keeps a BOM, leaves binary files out with a warning, dedups blobs', () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('hi')]);
    const main = md('d13', 'desc13', 'Body13\n');
    const r = buildVersion(input('d13', [['SKILL.md', main], ['bom.txt', bom], ['bin.dat', Uint8Array.from([0, 1])], ['bad.txt', Uint8Array.from([0xff, 0xfe, 0x41])], ['a.txt', 'hi2'], ['b.txt', 'hi2']]));
    if (!r.ok) throw new Error('expected ok');
    expect(r.input).toMatchObject({ name: 'd13', description: 'desc13', bodyHash: sha('Body13\n'), frontmatter: { name: 'd13', description: 'desc13' }, rootPath: '/r/d13' });
    expect(r.input.files.map((f) => f.path)).toEqual(['SKILL.md', 'a.txt', 'b.txt', 'bom.txt']);
    expect(r.input.blobs).toHaveLength(3);
    for (const b of r.input.blobs) expect([sha(Buffer.from(b.content, 'utf8')), Buffer.byteLength(b.content)]).toEqual([b.hash, b.size]);
    expect(r.warnings.map((w) => `${w.code} ${w.path}`).sort()).toEqual(['binary_file /r/d13/bad.txt', 'binary_file /r/d13/bin.dat']);
  });
  it('a binary or missing main file is unreadable; a skip path is the main file', () => {
    expect(buildVersion(input('d', [['SKILL.md', Uint8Array.from([0, 1])]]))).toMatchObject({ ok: false, skip: { code: 'unreadable', path: '/r/d/SKILL.md' } });
    expect(buildVersion(input('d', [['other.md', 'x']]))).toMatchObject({ ok: false, skip: { code: 'unreadable' } });
  });
  it('workflow YAML is one mapping and the whole text is the body', () => {
    const text = 'name: wf\ndescription: w\n';
    const r = buildVersion(input('wf', [['wf.yaml', text]], 'workflow', 'wf.yaml'));
    expect(r).toMatchObject({ ok: true, input: { frontmatter: { name: 'wf', description: 'w' }, bodyHash: sha(text) } });
  });
  it('defaults the name, trims the description, ignores a non-string name', () => {
    const r = buildVersion(input('fallback', [['SKILL.md', '---\ndescription: "  spaced  "\nname: 7\n---\n']]));
    expect(r).toMatchObject({ ok: true, input: { name: 'fallback', description: 'spaced' } });
  });
  it.each([['an escaped NUL', 'a\\0b'], ['an unpaired surrogate', '\\ud800']])('%s in the description is bad_yaml, not a value Postgres rejects', (_n, esc) => {
    expect(buildVersion(input('d', [['SKILL.md', `---\ndescription: "${esc}"\n---\n`]]))).toMatchObject({ ok: false, skip: { code: 'bad_yaml' } });
  });
  it('reports only the first failing check in the D4 order', () => {
    const bad = (text: string, extra: [string, string][] = []) => buildVersion(input('d', [['SKILL.md', text], ...extra]), { ...libraryLimits, maxFiles: 2, maxDescription: 3 });
    expect(bad('---\nname: [unclosed\n---\n', [['a', 'a'], ['b', 'b']])).toMatchObject({ skip: { code: 'too_many_files' } });
    expect(bad('---\nname: [unclosed\n---\n')).toMatchObject({ skip: { code: 'bad_yaml' } });
    expect(bad('---\nname: Bad_Name\ndescription: long text\n---\n')).toMatchObject({ skip: { code: 'bad_name' } });
    expect(bad('---\ndescription: long text\n---\n')).toMatchObject({ skip: { code: 'description_too_long' } });
  });
  it('does not edit a deep-frozen input (D6e)', () => {
    const frozen = input('d6', [['SKILL.md', md('d6', 'x')], ['a.md', 'a']]);
    Object.freeze(frozen); Object.freeze(frozen.files); frozen.files.forEach((f) => Object.freeze(f));
    expect(buildVersion(frozen).ok).toBe(true);
    expect(resolveServed(Object.freeze([Object.freeze({ version: 1, labels: Object.freeze(['latest', 'production']) })]))).toBe(1);
  });
  it('peekName returns the declared name only', () => {
    expect(peekName('skill', 'SKILL.md', enc(md('declared', 'x')))).toBe('declared');
    expect(peekName('skill', 'SKILL.md', enc('---\nname: [\n---\n'))).toBeNull();
  });
});

describe('manifest compare (D13)', () => {
  const m = [{ path: 'a', blobHash: '1' }, { path: 'b', blobHash: '2' }];
  it('sameManifest ignores order and detects a changed or extra entry', () => {
    expect([sameManifest(m, [...m].reverse()), sameManifest(m, [m[0] as (typeof m)[0], { path: 'b', blobHash: '3' }]), sameManifest(m, [...m, { path: 'c', blobHash: '4' }])]).toEqual([true, false, false]);
  });
  it('diffManifests lists added, removed and changed paths sorted', () => {
    expect(diffManifests([...m, { path: 'c', blobHash: '3' }], [{ path: 'd', blobHash: '4' }, { path: 'b', blobHash: '9' }, { path: 'a', blobHash: '1' }])).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] });
  });
  it('sha256Hex hashes strings as UTF-8', () => {
    expect(sha256Hex('x')).toBe(sha('x'));
  });
});

describe('resolveServed (D16)', () => {
  const vs = [{ version: 1, labels: ['production'] }, { version: 2, labels: ['staging'] }, { version: 3, labels: ['latest'] }];
  it('applies override, label, latest and highest in order; a dangling pin falls through', () => {
    expect([
      resolveServed(vs), resolveServed(vs, { defaultLabel: 'staging' }), resolveServed(vs, { override: { action: 'pin', version: 3 } }),
      resolveServed(vs, { override: { action: 'pin', label: 'staging' } }), resolveServed(vs, { override: { action: 'pin', version: 9 } }),
      resolveServed(vs, { override: { action: 'pin', label: 'nope' } }), resolveServed(vs, { override: { action: 'block' } }),
      resolveServed([{ version: 1, labels: [] }, { version: 2, labels: ['latest'] }]), resolveServed([{ version: 1, labels: [] }, { version: 4, labels: [] }]),
      resolveServed([]), resolveServed(vs, { override: null }),
    ]).toEqual([1, 2, 3, 2, 1, 1, null, 2, 4, null, 1]);
  });
});

describe('skillretText and cosine (D17)', () => {
  it('cuts the body to bodyChars', () => {
    expect(skillretText({ name: 'n', description: 'd', body: 'abcdef' }, 3)).toBe('n | d | abc');
    expect(skillretText({ name: 'n', description: 'd', body: 'x'.repeat(9000) }).length).toBe('n | d | '.length + 8000);
  });
  it('cosine is 1 for equal vectors, 0 for orthogonal, empty, zero or mismatched ones', () => {
    expect([cosine([1, 2], [1, 2]), cosine([1, 0], [0, 1]), cosine([], []), cosine([0, 0], [1, 1]), cosine([1], [1, 1])]).toEqual([1, 0, 0, 0, 0]);
  });
});
