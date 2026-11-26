/**
 * Syntax-highlighted code block for Ink TUI.
 * Simple regex-based highlighter for common languages.
 */
import { Box, Text } from 'ink';
import type React from 'react';

const JS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'try',
  'catch',
  'finally',
  'throw',
  'new',
  'this',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'in',
  'of',
  'import',
  'export',
  'from',
  'default',
  'class',
  'extends',
  'super',
  'async',
  'await',
  'static',
  'get',
  'set',
  'constructor',
  'yield',
  'true',
  'false',
  'null',
  'undefined',
]);

const PY_KEYWORDS = new Set([
  'def',
  'class',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'raise',
  'with',
  'as',
  'import',
  'from',
  'lambda',
  'pass',
  'break',
  'continue',
  'global',
  'nonlocal',
  'assert',
  'del',
  'yield',
  'True',
  'False',
  'None',
  'and',
  'or',
  'not',
  'in',
  'is',
]);

const SH_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'case',
  'esac',
  'function',
  'return',
  'exit',
  'export',
  'source',
]);

const GO_KEYWORDS = new Set([
  'package',
  'import',
  'func',
  'var',
  'const',
  'type',
  'struct',
  'interface',
  'map',
  'chan',
  'go',
  'defer',
  'return',
  'if',
  'else',
  'for',
  'range',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'fallthrough',
  'select',
]);

function getKeywords(lang: string): Set<string> {
  const l = lang.toLowerCase();
  if (l === 'python' || l === 'py') return PY_KEYWORDS;
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh') return SH_KEYWORDS;
  if (l === 'go' || l === 'golang') return GO_KEYWORDS;
  return JS_KEYWORDS; // default to JS/TS
}

type Token = { text: string; color?: string; bgColor?: string; bold?: boolean };

function tokenize(code: string, lang: string): Token[] {
  const keywords = getKeywords(lang);
  const tokens: Token[] = [];
  const lines = code.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let index = 0;

    while (index < line.length) {
      const rest = line.slice(index);

      // String literals
      const stringMatch = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
      if (stringMatch) {
        tokens.push({ text: stringMatch[0], color: 'green' });
        index += stringMatch[0].length;
        continue;
      }

      // Single-line comments
      if (rest.startsWith('//') || rest.startsWith('#')) {
        tokens.push({ text: rest, color: 'gray' });
        break;
      }

      // Multi-line comments start
      if (rest.startsWith('/*')) {
        const endIndex = rest.indexOf('*/');
        if (endIndex !== -1) {
          tokens.push({ text: rest.slice(0, endIndex + 2), color: 'gray' });
          index += endIndex + 2;
          continue;
        }
      }

      // Numbers
      const numberMatch = rest.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (numberMatch) {
        tokens.push({ text: numberMatch[0], color: 'yellow' });
        index += numberMatch[0].length;
        continue;
      }

      // Identifiers / keywords
      const idMatch = rest.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
      if (idMatch) {
        const word = idMatch[0];
        tokens.push({
          text: word,
          color: keywords.has(word) ? 'magenta' : undefined,
          bold: keywords.has(word),
        });
        index += word.length;
        continue;
      }

      // Whitespace / punctuation — emit as-is
      tokens.push({ text: rest[0] });
      index++;
    }

    if (li < lines.length - 1) {
      tokens.push({ text: '\n' });
    }
  }

  return tokens;
}

interface CodeBlockProps {
  code: string;
  language?: string;
  maxLines?: number;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, language = '', maxLines = 40 }) => {
  const lines = code.split('\n');
  const truncated = lines.length > maxLines;
  const displayCode = truncated ? lines.slice(0, maxLines).join('\n') : code;
  const tokens = tokenize(displayCode, language);

  // Group tokens into lines for Box rendering
  const lineGroups: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.text === '\n') {
      lineGroups.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) lineGroups.push(current);

  return (
    <Box flexDirection='column' marginLeft={2}>
      {language && (
        <Box marginBottom={1}>
          <Text dimColor color='gray'>
            {`─── ${language} ───`}
          </Text>
        </Box>
      )}
      <Box flexDirection='column'>
        {lineGroups.map((lg, index) => (
          <Box key={index} flexDirection='row' flexWrap='wrap'>
            {lg.map((t, tidx) => (
              <Text
                key={tidx}
                color={t.color as string}
                backgroundColor={t.bgColor as string}
                bold={t.bold}
                dimColor={t.color === 'gray'}
              >
                {t.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      {truncated && (
        <Box marginTop={1}>
          <Text dimColor color='gray'>
            {`… (${lines.length - maxLines} more lines)`}
          </Text>
        </Box>
      )}
    </Box>
  );
};
