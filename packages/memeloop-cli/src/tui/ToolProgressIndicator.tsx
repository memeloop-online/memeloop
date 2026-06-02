/**
 * ToolProgressIndicator — 工具执行进度指示器
 */
import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolProgress } from "./types.js";

interface Props {
  progress: ToolProgress;
}

export function ToolProgressIndicator({ progress }: Props) {
  const elapsed = Math.floor((Date.now() - progress.startTime.getTime()) / 1000);

  return (
    <Box marginY={1} paddingX={1}>
      <Text color={progress.status === "error" ? "red" : progress.status === "done" ? "green" : "yellow"}>
        {progress.status === "running" ? (
          <>
            <Spinner type="dots" />{" "}
          </>
        ) : progress.status === "done" ? (
          "✓ "
        ) : (
          "✗ "
        )}
        {progress.toolName}
      </Text>
      {progress.message && (
        <Text dimColor> — {progress.message}</Text>
      )}
      <Text dimColor> ({elapsed}s)</Text>
    </Box>
  );
}
