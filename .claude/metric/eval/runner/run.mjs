// Runs the three sample workflows of this directory on the scratch Postgres with the fake agent in throwaway repos (same harness as the gate test
// apps/worker/src/runner/runner.md.int.test.ts), answers every gate with its first option, and rewrites the "Results" table of ../runner.md.
//   CTC_SCRATCH_PG_URL=postgres://...@127.0.0.1:18304/<db> node --import tsx .claude/metric/eval/runner/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const { harness, restoreLimits, runSample, scratch, useFastLimits } = await import(pathToFileURL(path.join(root, 'apps/worker/src/runner/harness.ts')).href);

useFastLimits();
const s = await scratch();
const h = harness(s);
const rows = [];
try {
  for (const [file, inputs] of [['implement-review.yaml', { topic: 'widgets' }], ['fanout-merge.yaml', {}], ['loop-gate.yaml', {}]]) {
    const m = await runSample(h, s, file, inputs);
    rows.push(m);
    console.log(JSON.stringify({ ...m, reviewPrompt: undefined }));
  }
} finally {
  restoreLimits();
  await h.close();
  await s.drop();
}
const head = '| workflow | status | steps | attempts | agent_steps | prompt_outcome | children | gate_wait_ms | wall_ms | cost_usd |';
const table = [head, '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |',
  ...rows.map((m) => `| ${m.workflow} | ${m.status} | ${m.steps} | ${m.attempts} | ${m.agent_steps} | ${m.prompt_outcome ?? 'null'} | ${m.children} | ${m.gate_wait_ms} | ${m.wall_ms} | ${m.cost_usd} |`)].join('\n');
const md = path.join(root, '.claude/metric/eval/runner.md');
const text = fs.readFileSync(md, 'utf8');
const next = text.replace(/<!-- results:start -->[\s\S]*<!-- results:end -->/, `<!-- results:start -->\n${table}\n<!-- results:end -->`);
if (next === text && !text.includes(table)) throw new Error('runner.md has no results markers');
fs.writeFileSync(md, next);
console.log(`wrote ${md}`);
