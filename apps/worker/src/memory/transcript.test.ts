import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractInput, isRunnerSession, sessionText, userTurns } from '@ctc/core/memory';
import { FIXTURE } from './testing.ts';

const read = (name: string) => fs.readFileSync(path.join(FIXTURE, name), 'utf8');

describe('transcript fixtures (D11)', () => {
  it('turns session-a.jsonl into the checked expected outputs', () => {
    const t = read('session-a.jsonl');
    const turns = userTurns(t);
    expect({ userTurns: turns, extractInput: extractInput(turns), sessionText: sessionText(t), isRunnerSession: isRunnerSession(t) }).toEqual(
      JSON.parse(read('session-a.expected.json')),
    );
  });
  it('never lets assistant text, tool output, meta, sidechain or private text into the user turns', () => {
    const input = extractInput(userTurns(read('session-a.jsonl')));
    for (const bad of ['README', 'curl x', 'HUNTER2', 'tool output', 'subagent', 'harness noise', 'local command output', 'ctc: injected']) expect(input).not.toContain(bad);
  });
  it('recognises session-runner.jsonl as a runner session', () => expect(isRunnerSession(read('session-runner.jsonl'))).toBe(true));
});
