/**
 * Replaces comments with whitespace while preserving every source offset.
 * Strings and template literals are kept intact so a comment marker in a
 * diagnostic label cannot alter the review scan.
 */
export function stripCommentsPreservingOffsets(source) {
  let result = '';
  let index = 0;
  let state = 'code';
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        result += '  ';
        index += 2;
        state = 'line-comment';
        continue;
      }
      if (character === '/' && next === '*') {
        result += '  ';
        index += 2;
        state = 'block-comment';
        continue;
      }
      if (character === "'") state = 'single-quote';
      else if (character === '"') state = 'double-quote';
      else if (character === '`') state = 'template';
      result += character;
      index += 1;
      continue;
    }
    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        result += character;
        state = 'code';
      } else result += ' ';
      index += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 2;
        state = 'code';
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
        index += 1;
      }
      continue;
    }
    result += character;
    if (character === '\\') {
      if (index + 1 < source.length) {
        result += source[index + 1];
        index += 2;
      } else index += 1;
      continue;
    }
    if (
      (state === 'single-quote' && character === "'") ||
      (state === 'double-quote' && character === '"') ||
      (state === 'template' && character === '`')
    ) state = 'code';
    index += 1;
  }
  return result;
}

const emptyCatchPattern = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gu;
const emptyPromiseCatchPattern = /\.catch\(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/gu;

/** Returns source offsets for comment-only/empty rejection handlers. */
export function findEmptyCatchViolations(source) {
  const withoutComments = stripCommentsPreservingOffsets(source);
  const violations = [];
  for (const match of withoutComments.matchAll(emptyCatchPattern)) {
    violations.push({ index: match.index ?? 0, message: 'silently swallowed synchronous exception' });
  }
  for (const match of withoutComments.matchAll(emptyPromiseCatchPattern)) {
    violations.push({ index: match.index ?? 0, message: 'silently swallowed promise rejection' });
  }
  return violations.sort((left, right) => left.index - right.index);
}
