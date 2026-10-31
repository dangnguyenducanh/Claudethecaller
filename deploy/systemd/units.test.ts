import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');
const kv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  let sec = '';
  for (const line of text.split('\n')) {
    const s = /^\[(\w+)\]$/.exec(line.trim());
    if (s) sec = s[1] as string;
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m && sec) out[`${sec}.${m[1]}`] = m[2] as string;
  }
  return out;
};

describe('units (D22)', () => {
  const web = read('ctc-web.service');
  const worker = read('ctc-worker.service');
  it('share the restart policy, paths and install target', () => {
    for (const t of [web, worker]) {
      const u = kv(t);
      expect([u['Unit.StartLimitIntervalSec'], u['Unit.StartLimitBurst'], u['Service.Type'], u['Service.Restart'], u['Service.RestartSec'], u['Install.WantedBy']]).toEqual(['60', '5', 'simple', 'on-failure', '2', 'default.target']);
      expect([u['Service.WorkingDirectory'], u['Service.EnvironmentFile']]).toEqual(['%h/.claudethecaller', '-%h/.claudethecaller/env']);
      expect(t).not.toMatch(/RestartPreventExitStatus|Requires=|password|secret|token/i);
    }
  });
  it('differ in launcher, stop timeout, memory and kill mode', () => {
    const w = kv(web);
    const k = kv(worker);
    expect([w['Service.ExecStart'], w['Service.TimeoutStopSec'], w['Service.MemoryHigh'], w['Service.KillMode']]).toEqual(['%h/.claudethecaller/bin/ctc-web', '15', '600M', undefined]);
    expect([k['Service.ExecStart'], k['Service.TimeoutStopSec'], k['Service.MemoryHigh'], k['Service.KillMode']]).toEqual(['%h/.claudethecaller/bin/ctc-worker', '20', '1G', 'process']);
  });
});
