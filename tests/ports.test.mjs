import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baseUrlForPort, inBand, isReserved, preferredPort, resolvePort } from '../src/worktree/ports.mjs';

const BAND = [3100, 3999];
const RESERVED = ['0-1023', '2375-2376', '3000', '5000', '5432', '6379', '7000', '54320-59999'];
const free = () => false;
const taken = () => true;

test('reserved covers inclusive ranges and bare values', () => {
  assert.equal(isReserved(80, RESERVED), true);
  assert.equal(isReserved(1023, RESERVED), true);
  assert.equal(isReserved(1024, RESERVED), false);
  assert.equal(isReserved(3000, RESERVED), true);
  assert.equal(isReserved(54320, RESERVED), true);
  assert.equal(isReserved(59999, RESERVED), true);
  assert.equal(isReserved(3412, RESERVED), false);
});

test('a malformed reserved entry throws instead of silently un-reserving a range', () => {
  // The failure guarded here: a typo in the Supabase range hands a worktree a
  // port the database answers on, and the symptom surfaces far from the config.
  assert.throws(() => isReserved(3412, ['54320-5999o']), /malformed reserved port entry/);
  assert.throws(() => isReserved(3412, ['54,320']), /malformed reserved port entry/);
  assert.throws(() => isReserved(3412, ['59999-54320']), /runs backwards/);
});

test('a seed is folded into the band by modulo, never clamped onto the ceiling', () => {
  assert.equal(inBand(0, BAND), 3100);
  assert.equal(inBand(899, BAND), 3999);
  assert.equal(inBand(900, BAND), 3100);
  // Two large, distinct seeds must stay distinct — clamping would collapse both.
  assert.notEqual(inBand(4023456789, BAND), inBand(4023456790, BAND));
  assert.ok(inBand(4023456789, BAND) >= 3100 && inBand(4023456789, BAND) <= 3999);
  // A negative seed stays in the band and does NOT mirror onto its positive
  // twin: `Math.abs` would give -1 and 1 the same port.
  assert.equal(inBand(-1, BAND), 3999);
  assert.equal(inBand(-900, BAND), 3100);
  assert.notEqual(inBand(-1, BAND), inBand(1, BAND));
});

test('issue #412 wants port 3412, and the thousand comes from the band', () => {
  assert.equal(preferredPort({ issue: 412 }, BAND), 3412);
  assert.equal(preferredPort({ issue: 412 }, [4100, 4999]), 4412);
});

test('an issue outside the band is folded in rather than rejected', () => {
  // #1 would be 3001, below the band and next door to the main checkout.
  assert.equal(preferredPort({ issue: 1 }, BAND), inBand(1, BAND));
  assert.equal(preferredPort({ issue: 1 }, BAND), 3101);
  // #1500 would be 4500, above the band.
  assert.equal(preferredPort({ issue: 1500 }, BAND), 3700);
});

test('without an issue the seed decides, stably', () => {
  assert.equal(preferredPort({ seed: 1234567 }, BAND), inBand(1234567, BAND));
});

test('a recorded port is kept even when something is listening on it', () => {
  // It is bound BY THIS WORKTREE's dev server, and the URL is already published
  // to an agent, a browser tab and a Playwright auth state.
  const resolved = resolvePort({
    identity: { issue: 412 },
    band: BAND,
    reserved: RESERVED,
    recorded: '3555',
    isBound: taken,
  });
  assert.deepEqual(resolved, { port: 3555, source: 'recorded' });
});

test('a recorded port that is reserved or not a number is refused', () => {
  const reservedRecord = resolvePort({
    identity: { issue: 412 },
    band: BAND,
    reserved: RESERVED,
    recorded: '3000',
    isBound: free,
  });
  assert.deepEqual(reservedRecord, { port: 3412, source: 'preferred' });

  for (const recorded of ['', 'auto', undefined, null, '34a2']) {
    assert.deepEqual(
      resolvePort({ identity: { issue: 412 }, band: BAND, reserved: RESERVED, recorded, isBound: free }),
      { port: 3412, source: 'preferred' },
    );
  }
});

test('a collision costs the next neighbouring port, not a jump across the band', () => {
  const resolved = resolvePort({
    identity: { issue: 412 },
    band: BAND,
    reserved: RESERVED,
    isBound: port => port === 3412,
  });
  assert.deepEqual(resolved, { port: 3413, source: 'scanned' });
});

test('a reserved preferred port is scanned past', () => {
  const resolved = resolvePort({
    identity: { issue: 412 },
    band: BAND,
    reserved: [...RESERVED, '3412-3414'],
    isBound: free,
  });
  assert.deepEqual(resolved, { port: 3415, source: 'scanned' });
});

test('the scan wraps at the top of the band', () => {
  const narrow = [3100, 3102];
  const resolved = resolvePort({
    identity: { issue: 102 },
    band: narrow,
    isBound: port => port !== 3100,
  });
  assert.deepEqual(resolved, { port: 3100, source: 'scanned' });
});

test('a full band throws instead of returning a port someone else owns', () => {
  assert.throws(
    () => resolvePort({ identity: { issue: 102 }, band: [3100, 3102], isBound: taken }),
    /no free port in 3100-3102/,
  );
});

test('the base url is the port on localhost', () => {
  assert.equal(baseUrlForPort(3412), 'http://localhost:3412');
});
