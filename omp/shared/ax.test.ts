import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { axArgv } from './ax.ts';

test('default argv runs this package entry through the current runtime', () => {
  expect(axArgv({})).toEqual([
    process.execPath,
    fileURLToPath(new URL('../ax-run.mjs', import.meta.url)),
  ]);
});

test('a deliberate AX_BIN override is one argv word, never shell text', () => {
  expect(axArgv({ AX_BIN: '/tmp/ax checkout/bin/ax' })).toEqual(['/tmp/ax checkout/bin/ax']);
});
