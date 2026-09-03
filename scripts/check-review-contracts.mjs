import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packagesRoot = join(repositoryRoot, 'packages');
const sourceExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const skippedDirectories = new Set(['__fixtures__', '__tests__', 'build', 'coverage', 'dist', 'node_modules', 'out']);

async function productionSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...await productionSourceFiles(path));
      continue;
    }
    if (
      entry.isFile() &&
      sourceExtensions.has(extname(entry.name)) &&
      !/\.test\.tsx?$/u.test(entry.name) &&
      !/\.stories\.tsx?$/u.test(entry.name)
    ) files.push(path);
  }
  return files;
}

const checks = [
  { pattern: /\bas unknown as\b/gu, message: 'double assertion (as unknown as)' },
  { pattern: /\bas any\b/gu, message: 'untyped assertion (as any)' },
  { pattern: /<any>/gu, message: 'untyped angle-bracket assertion (<any>)' },
  { pattern: /\bas never\b/gu, message: 'escape-hatch assertion (as never)' },
  { pattern: /\blegacy\b/giu, message: 'legacy compatibility path' },
  { pattern: /\bcompatibility\b/giu, message: 'compatibility fallback path' },
];

/**
 * Replace comments with whitespace while preserving offsets/newlines. A small
 * lexer is used instead of a regex so comment-looking text inside strings and
 * template literal bodies remains source text. `${...}` expressions re-enter
 * code mode, allowing comments there to be stripped recursively.
 */
function sourceWithoutComments(source) {
  const output = [...source];
  const length = source.length;

  const maskLineComment = (start) => {
    let index = start;
    while (index < length && source[index] !== '\n' && source[index] !== '\r') {
      output[index] = ' ';
      index += 1;
    }
    return index;
  };

  const maskBlockComment = (start) => {
    let index = start;
    while (index < length) {
      if (source[index] === '*' && source[index + 1] === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        return index + 2;
      }
      if (source[index] !== '\n' && source[index] !== '\r') output[index] = ' ';
      index += 1;
    }
    return index;
  };

  const skipQuoted = (start, quote) => {
    let index = start + 1;
    while (index < length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === quote) return index + 1;
      index += 1;
    }
    return index;
  };

  let scanCode;
  const skipTemplate = (start) => {
    let index = start + 1;
    while (index < length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === '`') return index + 1;
      if (source[index] === '$' && source[index + 1] === '{') {
        index = scanCode(index + 2, true);
        continue;
      }
      index += 1;
    }
    return index;
  };

  scanCode = (start, stopAtBrace) => {
    let index = start;
    let braceDepth = stopAtBrace ? 1 : 0;
    while (index < length) {
      const character = source[index];
      if (stopAtBrace && character === '}') {
        braceDepth -= 1;
        index += 1;
        if (braceDepth === 0) return index;
        continue;
      }
      if (character === '{') {
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (character === '\'' || character === '"') {
        index = skipQuoted(index, character);
        continue;
      }
      if (character === '`') {
        index = skipTemplate(index);
        continue;
      }
      if (character === '/' && source[index + 1] === '/') {
        index = maskLineComment(index);
        continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        index = maskBlockComment(index);
        continue;
      }
      index += 1;
    }
    return index;
  };

  scanCode(0, false);
  return output.join('');
}

const emptyCatchPatterns = [
  {
    pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/gu,
    message: 'silently swallowed synchronous exception',
  },
  {
    pattern: /\.catch\(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/gu,
    message: 'silently swallowed promise rejection',
  },
];

export function scanEmptyHandlers(source, file) {
  const uncommented = sourceWithoutComments(source);
  const violations = [];
  for (const { pattern, message } of emptyCatchPatterns) {
    for (const match of uncommented.matchAll(pattern)) {
      const start = match.index ?? 0;
      const line = source.slice(0, start).split('\n').length;
      violations.push(`${relative(repositoryRoot, file)}:${line} ${message}`);
    }
  }
  return violations;
}

export async function runReviewContractChecks() {
  const files = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceRoot = join(packagesRoot, entry.name, 'src');
    try {
      files.push(...await productionSourceFiles(sourceRoot));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const { pattern, message } of checks) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index ?? 0).split('\n').length;
        violations.push(`${relative(repositoryRoot, file)}:${line} ${message}`);
      }
    }
    violations.push(...scanEmptyHandlers(source, file));
  }

  if (violations.length > 0) {
    throw new Error(`Repository review contract checks failed:\n${violations.join('\n')}`);
  }

  return { files: files.length, violations };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runReviewContractChecks();
  console.log(`Repository review contract checks passed across ${result.files} production source files.`);
}
