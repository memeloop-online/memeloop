/**
 * Structured diff display for the TUI — shows file edits with syntax coloring.
 *
 * Based on: Claude Code StructuredDiff + FileEditToolDiff
 */
import React from "react";
import { Box, Text } from "ink";

interface DiffLine {
  type: "add" | "del" | "context" | "header";
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
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = buildLCS(oldLines, newLines);
  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length) {
      // Output deletions before the next common line
      while (oldIdx < oldLines.length && oldLines[oldIdx] !== lcs[lcsIdx]) {
        result.push({ type: "del", content: oldLines[oldIdx], oldLine: oldLineNum });
        oldIdx++;
        oldLineNum++;
      }
      // Output additions before the next common line
      while (newIdx < newLines.length && newLines[newIdx] !== lcs[lcsIdx]) {
        result.push({ type: "add", content: newLines[newIdx], newLine: newLineNum });
        newIdx++;
        newLineNum++;
      }
      // Output the common line
      if (lcsIdx < lcs.length) {
        result.push({ type: "context", content: lcs[lcsIdx], oldLine: oldLineNum, newLine: newLineNum });
        oldIdx++;
        newIdx++;
        oldLineNum++;
        newLineNum++;
        lcsIdx++;
      }
    } else {
      // Remaining lines are all additions/deletions
      while (oldIdx < oldLines.length) {
        result.push({ type: "del", content: oldLines[oldIdx], oldLine: oldLineNum });
        oldIdx++;
        oldLineNum++;
      }
      while (newIdx < newLines.length) {
        result.push({ type: "add", content: newLines[newIdx], newLine: newLineNum });
        newIdx++;
        newLineNum++;
      }
    }
  }

  return result;
}

function buildLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

const DiffLineComponent: React.FC<{ line: DiffLine }> = ({ line }) => {
  const colors = {
    add: { bg: undefined as string | undefined, fg: "#00ff00" as string, prefix: "+" },
    del: { bg: undefined as string | undefined, fg: "#ff4444" as string, prefix: "-" },
    context: { bg: undefined as string | undefined, fg: "gray" as string, prefix: " " },
    header: { bg: undefined as string | undefined, fg: "#88aaff" as string, prefix: "@" },
  };
  const style = colors[line.type];

  return (
    <Box>
      <Text color={style.fg} dimColor={line.type === "context"}>
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

  const adds = diff.filter((l) => l.type === "add").length;
  const dels = diff.filter((l) => l.type === "del").length;
  const truncated = diff.length > maxLines;
  const displayLines = truncated ? diff.slice(0, maxLines) : diff;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {filePath && (
        <Box marginBottom={1}>
          <Text color="#88aaff" bold>
            📄 {filePath}
          </Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text color="#00ff00">+{adds}</Text>
        <Text> / </Text>
        <Text color="#ff4444">-{dels}</Text>
        {truncated && (
          <Text dimColor> ({diff.length - maxLines} more lines hidden)</Text>
        )}
      </Box>
      {displayLines.map((line, i) => (
        <DiffLineComponent key={i} line={line} />
      ))}
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
  const oldLines = oldText.split("\n").length;
  const newLines = newText.split("\n").length;
  const diff = newLines - oldLines;

  return (
    <Box>
      {label && <Text bold>{label}: </Text>}
      <Text color={diff > 0 ? "#00ff00" : diff < 0 ? "#ff4444" : "gray"}>
        {oldLines} → {newLines} lines ({diff >= 0 ? "+" : ""}{diff})
      </Text>
    </Box>
  );
};
