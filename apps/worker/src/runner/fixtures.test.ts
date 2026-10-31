import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyStream, readStreamLine } from '@ctc/core/runner';
import { gitErrorLine } from './git.ts';

const fixture = (name: string): string => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const read = (agent: string, text: string) => text.split('\n').reduce((s, l) => readStreamLine(agent, s, l), emptyStream());

describe('fixtures (hand-written stream shapes, real git stderr)', () => {
  it('reads the claude stream fixture: noise counted or ignored, result wins', () => {
    const s = read('claude', fixture('claude-stream.jsonl'));
    expect([s.events, s.lastMessage, s.usage, s.costUsd, s.quota]).toEqual([4, 'Fixed the bug.', { input_tokens: 12, output_tokens: 34 }, 0.07, null]);
  });

  it('reads the codex stream fixture and keeps cost null', () => {
    const s = read('codex', fixture('codex-stream.jsonl'));
    expect([s.events, s.lastMessage, s.usage, s.costUsd]).toEqual([4, 'Done with the change.', { input_tokens: 5, cached_input_tokens: 1, output_tokens: 3 }, null]);
  });

  it('takes the fatal line from the real git stderr of a second worktree add of one branch', () => {
    expect(gitErrorLine({ code: 255, timedOut: false, aborted: false, overflow: false, text: fixture('git-branch-exists.txt') })).toBe("fatal: A branch named 'ctc/x' already exists.");
    expect(gitErrorLine({ code: 7, timedOut: false, aborted: false, overflow: false, text: '' })).toBe('exit 7');
  });
});
