/**
 * Structured diff display for the TUI — shows file edits with syntax coloring.
 *
 * Based on: Claude Code StructuredDiff + FileEditToolDiff
 */
import { Box, Text } from 'ink';
import React from 'react';

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffViewProps {
  /** Original text */
  oldText: string;
  /** New text */
  newText: string;
  /** File path for display */
  filePath?: string;
  /** Maximum lines to show */
  maxLines?: number;
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = buildLCS(oldLines, newLines);
  let oldIndex = 0;
  let newIndex = 0;
  let lcsIndex = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (lcsIndex < lcs.length) {
      // Output deletions before the next common line
      while (oldIndex < oldLines.length && oldLines[oldIndex] !== lcs[lcsIndex]) {
        result.push({ type: 'del', content: oldLines[oldIndex], oldLine: oldLineNumber });
        oldIndex++;
        oldLineNumber++;
      }
      // Output additions before the next common line
      while (newIndex < newLines.length && newLines[newIndex] !== lcs[lcsIndex]) {
        result.push({ type: 'add', content: newLines[newIndex], newLine: newLineNumber });
        newIndex++;
        newLineNumber++;
      }
      // Output the common line
      if (lcsIndex < lcs.length) {
        result.push({ type: 'context', content: lcs[lcsIndex], oldLine: oldLineNumber, newLine: newLineNumber });
        oldIndex++;
        newIndex++;
        oldLineNumber++;
        newLineNumber++;
        lcsIndex++;
      }
    } else {
      // Remaining lines are all additions/deletions
      while (oldIndex < oldLines.length) {
        result.push({ type: 'del', content: oldLines[oldIndex], oldLine: oldLineNumber });
        oldIndex++;
        oldLineNumber++;
      }
      while (newIndex < newLines.length) {
        result.push({ type: 'add', content: newLines[newIndex], newLine: newLineNumber });
        newIndex++;
        newLineNumber++;
      }
    }
  }

  return result;
}

function buildLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let index = 1; index <= m; index++) {
    for (let index_ = 1; index_ <= n; index_++) {
      if (a[index - 1] === b[index_ - 1]) {
        dp[index][index_] = dp[index - 1][index_ - 1] + 1;
      } else {
        dp[index][index_] = Math.max(dp[index - 1][index_], dp[index][index_ - 1]);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let index = m;
  let index_ = n;
  while (index > 0 && index_ > 0) {
    if (a[index - 1] === b[index_ - 1]) {
      result.unshift(a[index - 1]);
      index--;
      index_--;
    } else if (dp[index - 1][index_] >= dp[index][index_ - 1]) {
      index--;
    } else {
      index_--;
    }
  }

  return result;
}

const DiffLineComponent: React.FC<{ line: DiffLine }> = ({ line }) => {
  const colors = {
    add: { bg: undefined as string | undefined, fg: '#00ff00' as string, prefix: '+' },
    del: { bg: undefined as string | undefined, fg: '#ff4444' as string, prefix: '-' },
    context: { bg: undefined as string | undefined, fg: 'gray' as string, prefix: ' ' },
    header: { bg: undefined as string | undefined, fg: '#88aaff' as string, prefix: '@' },
  };
  const style = colors[line.type];

  return (
    <Box>
      <Text color={style.fg} dimColor={line.type === 'context'}>
        {style.prefix} {line.content}
      </Text>
    </Box>
  );
};

/**
 * DiffView — displays a structured diff between two texts.
 */
export const DiffView: React.FC<DiffViewProps> = ({
  oldText,
  newText,
  filePath,
  maxLines = 50,
}) => {
  const diff = computeDiff(oldText, newText);

  const adds = diff.filter((l) => l.type === 'add').length;
  const dels = diff.filter((l) => l.type === 'del').length;
  const truncated = diff.length > maxLines;
  const displayLines = truncated ? diff.slice(0, maxLines) : diff;

  return (
    <Box flexDirection='column' borderStyle='round' borderColor='gray' paddingX={1}>
      {filePath && (
        <Box marginBottom={1}>
          <Text color='#88aaff' bold>
            📄 {filePath}
          </Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text color='#00ff00'>+{adds}</Text>
        <Text>/</Text>
        <Text color='#ff4444'>-{dels}</Text>
        {truncated && <Text dimColor>({diff.length - maxLines} more lines hidden)</Text>}
      </Box>
      {displayLines.map((line, index) => <DiffLineComponent key={index} line={line} />)}
    </Box>
  );
};

/**
 * Inline diff summary — shows just the change stats for tool output.
 */
export const InlineDiffStats: React.FC<{
  oldText: string;
  newText: string;
  label?: string;
}> = ({ oldText, newText, label }) => {
  const oldLines = oldText.split('\n').length;
  const newLines = newText.split('\n').length;
  const diff = newLines - oldLines;

  return (
    <Box>
      {label && <Text bold>{label}:</Text>}
      <Text color={diff > 0 ? '#00ff00' : diff < 0 ? '#ff4444' : 'gray'}>
        {oldLines} → {newLines} lines ({diff >= 0 ? '+' : ''}
        {diff})
      </Text>
    </Box>
  );
};
