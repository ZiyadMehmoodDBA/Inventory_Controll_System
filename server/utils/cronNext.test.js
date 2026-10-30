const test = require('node:test');
const assert = require('node:assert');
const { parse, nextRuns, minGapMinutes } = require('./cronNext');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);

test('parse accepts numeric 5-field expressions and rejects the rest', () => {
  for (const ok of ['0 2 * * *', '*/30 * * * *', '30 3 * * 0', '0 9-17/2 * * 1-5', '5,35 * * * *'])
    assert.ok(parse(ok), ok);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 7', '*/0 * * * *', 'a b c d e', '0 2 * * mon', '5-1 * * * *', '* * * * * *'])
    assert.strictEqual(parse(bad), null, bad);
});

test('nextRuns: daily, every 30 minutes, weekly', () => {
  const from = at(2026, 10, 30, 11, 26);                                    // a Friday
  assert.deepStrictEqual(nextRuns('0 2 * * *', 2, from), [at(2026, 10, 31, 2, 0), at(2026, 11, 1, 2, 0)]);
  assert.deepStrictEqual(nextRuns('*/30 * * * *', 3, from), [at(2026, 10, 30, 11, 30), at(2026, 10, 30, 12, 0), at(2026, 10, 30, 12, 30)]);
  assert.deepStrictEqual(nextRuns('30 3 * * 0', 1, from), [at(2026, 11, 1, 3, 30)]);   // Sunday
});

test('nextRuns never returns the starting minute and respects month and day-of-month', () => {
  const from = at(2026, 1, 15, 10, 0);
  assert.deepStrictEqual(nextRuns('0 10 * * *', 1, from), [at(2026, 1, 16, 10, 0)]);
  assert.deepStrictEqual(nextRuns('0 0 1 3 *', 1, from), [at(2026, 3, 1, 0, 0)]);
  assert.deepStrictEqual(nextRuns('0 0 31 * *', 3, from).map(d => d.getMonth() + 1), [1, 3, 5]);   // months with 31 days
  assert.deepStrictEqual(nextRuns('nonsense', 1, from), []);
});

test('minGapMinutes finds the tightest spacing', () => {
  const from = at(2026, 10, 30, 0, 0);
  assert.strictEqual(minGapMinutes('*/30 * * * *', from), 30);
  assert.strictEqual(minGapMinutes('* * * * *', from), 1);
  assert.strictEqual(minGapMinutes('0,5 * * * *', from), 5);
  assert.strictEqual(minGapMinutes('0 2 * * *', from), 1440);
  assert.strictEqual(minGapMinutes('0 0 1 1 *', from), Infinity);
});
