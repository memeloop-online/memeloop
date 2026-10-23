import assert from 'node:assert/strict';
import test from 'node:test';

import { findEmptyCatchViolations, stripCommentsPreservingOffsets } from './checkReviewContractsLib.mjs';

test('comment stripping preserves offsets and catches synchronous no-ops', () => {
  const source = 'catch (error) { /* ignored */\n // still ignored\n }';
  const stripped = stripCommentsPreservingOffsets(source);
  assert.equal(stripped.length, source.length);
  assert.deepEqual(findEmptyCatchViolations(source), [
    { index: 0, message: 'silently swallowed synchronous exception' },
  ]);
});

test('promise scanner handles parameters and async handlers', () => {
  const source = [
    'promise.catch(error => { /* no-op */ });',
    'promise.catch(async error => { // no-op\n });',
    'promise.catch(() => { report(error); });',
  ].join('\n');
  assert.deepEqual(findEmptyCatchViolations(source), [
    { index: source.indexOf('.catch'), message: 'silently swallowed promise rejection' },
    { index: source.indexOf('.catch(async'), message: 'silently swallowed promise rejection' },
  ]);
});
