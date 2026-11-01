// Fake agent for the runner eval and the runner gate tests: reads its prompt from stdin, optionally writes and commits a file, prints the same
// stream-json lines the real claude prints. Steered by directives inside the prompt (FAKE_MODE=ok|fail|quota_once, FAKE_SAY=<word>,
// FAKE_SLEEP=<ms>, FAKE_WRITE=<file>:<word>, FAKE_NOCOMMIT=1, FAKE_RESET=<unix seconds>). Writes a snapshot (start, end, cwd, argv, stdin) to
// $FAKE_OUT/agent-<step id>-<pid>.json so a test can read what the agent saw. Never talks to the network or to a real model.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString()));
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(stdin) {
  const pick = (re, d) => (re.exec(stdin) || [])[1] ?? d;
  const mode = pick(/FAKE_MODE=(\w+)/, 'ok');
  const ms = Number(pick(/FAKE_SLEEP=(\d+)/, 0));
  const say = pick(/FAKE_SAY=([\w-]+)/, 'done');
  const write = /FAKE_WRITE=([\w.-]+):([\w-]+)/.exec(stdin);
  const reset = Number(pick(/FAKE_RESET=(\d+)/, 1893456000));
  const snap = { start: Date.now(), argv: process.argv.slice(2), cwd: process.cwd(), stdin };
  const file = `${process.env.FAKE_OUT}/agent-${process.env.CTC_STEP_ID}-${process.pid}.json`;
  const save = () => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap));
    fs.renameSync(`${file}.tmp`, file);
  };
  save();
  line({ type: 'system', subtype: 'init' });
  if (mode === 'fail') {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (mode === 'quota_once') {
    const marker = `${process.env.FAKE_OUT}/quota-${process.env.CTC_RUN_ID}`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1');
      line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset } });
      setInterval(() => {}, 1000);
      return;
    }
  }
  if (ms) await wait(ms);
  if (write) {
    fs.writeFileSync(write[1], `${write[2]}\n`);
    if (!/FAKE_NOCOMMIT=1/.test(stdin)) {
      const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
      g('add', '-A');
      g('commit', '-q', '-m', 'agent');
    }
  }
  snap.end = Date.now();
  save();
  line({ type: 'assistant', message: { content: [{ type: 'text', text: say }] } });
  line({ type: 'result', subtype: 'success', is_error: false, result: say, usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.25 });
}
