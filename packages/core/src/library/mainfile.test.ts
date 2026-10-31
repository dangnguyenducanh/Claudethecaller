import { describe, expect, it } from 'vitest';
import { bodyOf, mainPathOf } from './index.ts';

describe('mainPathOf (D21)', () => {
  it('is SKILL.md when present, else the only path, else null', () => {
    expect([mainPathOf(['ref.md', 'SKILL.md']), mainPathOf(['x.md']), mainPathOf(['a.md', 'b.md']), mainPathOf([])]).toEqual(['SKILL.md', 'x.md', null, null]);
  });
});

describe('bodyOf (D21)', () => {
  const md = '---\nname: x\n---\nBody\n';
  it('drops the frontmatter of markdown files, also for a workflow whose main file is markdown', () => {
    expect([bodyOf('skill', 'SKILL.md', md), bodyOf('workflow', 'w.md', md)]).toEqual(['Body\n', 'Body\n']);
  });
  it('keeps the whole content of a YAML or JSON workflow (any case)', () => {
    expect([bodyOf('workflow', 'w.YAML', md), bodyOf('workflow', 'w.yml', md), bodyOf('workflow', 'w.json', '{"a":1}')]).toEqual([md, md, '{"a":1}']);
  });
  it('keeps the whole content when the header does not parse or is missing', () => {
    const bad = '---\na: [\n---\nB\n';
    expect([bodyOf('agent', 'a.md', bad), bodyOf('command', 'c.md', 'no header\n')]).toEqual([bad, 'no header\n']);
  });
});
