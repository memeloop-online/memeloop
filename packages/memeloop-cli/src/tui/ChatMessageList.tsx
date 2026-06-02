/**
 * ChatMessageList — 渲染消息历史流
 */
import React from "react";
import { Box, Text } from "ink";
import type { TUIMessage } from "./types.js";
import { CodeBlock } from "./CodeBlock.js";

interface Props {
  messages: TUIMessage[];
  thinking: boolean;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return "";
  // Show key params, truncate long values
  const entries = Object.entries(input).slice(0, 3);
  return entries
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
    })
    .join(", ");
}

function formatToolResult(result: string | undefined, maxLen = 500): string {
  if (!result) return "";
  // Strip XML-like tags for cleaner display
  const cleaned = result.replace(/<\/?functions_result[^>]*>/g, "").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + `\n… (${cleaned.length - maxLen} more chars)`;
}

const roleStyle: Record<string, { label: string; color: string }> = {
  user: { label: "▸ You", color: "cyan" },
  assistant: { label: "● MemeLoop", color: "green" },
  tool: { label: "⚙ Tool", color: "yellow" },
  system: { label: "─ System", color: "grey" },
};

/** Parse markdown code blocks and render with syntax highlighting */
function renderContent(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      parts.push(
        <Box key={`text-${lastIndex}`} marginLeft={2}>
          <Text>{content.slice(lastIndex, match.index)}</Text>
        </Box>,
      );
    }
    // Code block
    const lang = match[1];
    const code = match[2];
    parts.push(<CodeBlock key={`code-${match.index}`} code={code} language={lang} />);
    lastIndex = regex.lastIndex;
  }

  // Remaining text
  if (lastIndex < content.length) {
    parts.push(
      <Box key={`text-end`} marginLeft={2}>
        <Text>{content.slice(lastIndex)}</Text>
      </Box>,
    );
  }

  return parts.length > 0 ? parts : <Box marginLeft={2}><Text>{content}</Text></Box>;
}

export function ChatMessageList({ messages, thinking }: Props) {
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {messages.map((msg) => {
        const style = roleStyle[msg.role] ?? roleStyle.system;
        return (
          <Box key={msg.id} flexDirection="column" marginY={1}>
            <Box>
              <Text bold color={style.color}>
                {style.label}
              </Text>
              <Text dimColor> {formatTime(msg.timestamp)}</Text>
            </Box>
            {msg.thinking && (
              <Box marginLeft={2}>
                <Text dimColor italic>
                  💭 {msg.thinking}
                </Text>
              </Box>
            )}
            {msg.toolName && (
              <Box marginLeft={2}>
                <Text color="blue">
                  🔧 {msg.toolName}({formatToolInput(msg.toolInput)})
                </Text>
              </Box>
            )}
            {msg.toolResult && (
              <Box marginLeft={2} flexDirection="column">
                <Text color="grey">{formatToolResult(msg.toolResult)}</Text>
              </Box>
            )}
            {msg.content && msg.role !== "tool" && (
              <Box flexDirection="column">
                {renderContent(msg.content)}
              </Box>
            )}
          </Box>
        );
      })}
      {thinking && (
        <Box>
          <Text color="yellow" dimColor>
            ● Thinking...
          </Text>
        </Box>
      )}
    </Box>
  );
}
