import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

test('the OMP bundle invokes this package CLI, not PATH or a global ax', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'omp', 'ax-run.mjs'), '--version'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out.trim(), VERSION);
});
