#!/usr/bin/env node
/** `ctc` entry point. Only `migrate` exists so far. */
import { runMigrate } from './migrate.ts';

const [command, ...rest] = process.argv.slice(2);
if (command === 'migrate') {
  process.exit(await runMigrate(rest));
}
process.stderr.write('usage: ctc migrate [options]\n');
process.exit(2);
