import assert from 'node:assert/strict';
import test from 'node:test';

import { scanEmptyHandlers } from '../check-review-contracts.mjs';

test('review contract scanner rejects comment-only synchronous catches', () => {
  const violations = scanEmptyHandlers(
    [
      'try { work(); } catch { /* cleanup is best effort */ }',
      'try { work(); } catch (error) { report(error); }',
    ].join('\n'),
    '/virtual/review-catch.ts',
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /silently swallowed synchronous exception/u);
});

test('review contract scanner rejects empty promise handlers including async arrows', () => {
  const violations = scanEmptyHandlers(
    [
      'void task.catch(() => {});',
      'void task.catch(async () => { /* intentionally ignored */ });',
      'void task.catch(error => { report(error); });',
    ].join('\n'),
    '/virtual/review-promise-catch.ts',
  );
  assert.equal(violations.length, 2);
  assert.ok(violations.every(violation => /silently swallowed promise rejection/u.test(violation)));
});

test('review contract scanner does not allow marker-based empty handlers', () => {
  const violations = scanEmptyHandlers(
    'try { work(); } catch { /* review-allow-empty-catch: legacy */ }',
    '/virtual/review-marker.ts',
  );
  assert.equal(violations.length, 1);
});

test('review contract scanner preserves comment-looking strings and template text', () => {
  const violations = scanEmptyHandlers(
    [
      'const text = "catch { /* not a handler */ } // literal";',
      'const template = `catch { /* template text */ }`;',
      'const escaped = \'escaped \\\' quote // text\';',
      'try { work(); } catch { /* actual handler */ }',
    ].join('\n'),
    '/virtual/review-strings.ts',
  );
  assert.equal(violations.length, 1);
});

test('review contract scanner strips comments in template expressions', () => {
  const violations = scanEmptyHandlers(
    'const template = `value: ${(() => { try { work(); } catch { /* actual handler */ } })()}`;',
    '/virtual/review-template-expression.ts',
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /silently swallowed synchronous exception/u);
});
