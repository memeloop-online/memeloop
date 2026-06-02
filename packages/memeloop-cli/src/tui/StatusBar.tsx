/**
 * StatusBar — 底部状态栏（模式、消息数、状态）
 */
import React from "react";
import { Box, Text } from "ink";
import type { TUIMode } from "./types.js";

interface Props {
  text: string;
  mode: TUIMode;
  messageCount: number;
}

const modeColor: Record<string, string> = {
  chat: "cyan",
  plan: "yellow",
  autopilot: "magenta",
};

export function StatusBar({ text, mode, messageCount }: Props) {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box>
        <Text dimColor>MemeLoop CLI</Text>
        <Text> │ </Text>
        <Text color={modeColor[mode] ?? "white"} bold>
          {mode.toUpperCase()}
        </Text>
        <Text dimColor> │ {text}</Text>
      </Box>
      <Box>
        <Text dimColor>
          msgs: {messageCount}
        </Text>
      </Box>
    </Box>
  );
}
