import { type ConversationMessageListProjection, readConversationToolActivity } from 'memeloop';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import { hasToolCommentary, isToolMessage, requiresAttention, type WorkNode } from '../chat/thread/workDisclosureModel.js';
import type { NativeAgentChatLabels } from './agentChatLabels.js';

export function visibleWorkNodes(nodes: readonly WorkNode[], expanded: ReadonlySet<string>): WorkNode[] {
  return nodes.flatMap(node => node.kind === 'message' || !expanded.has(node.key) ? [node] : [node, ...visibleWorkNodes(node.children, expanded)]);
}

export function workNodeTimestamp(node: WorkNode): number {
  return node.kind === 'message' ? node.row.message.timestamp : node.children.length ? workNodeTimestamp(node.children[0]) : 0;
}

export function NativeWorkToggle({ label, expanded, onPress }: { label: string; expanded: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 }}
    >
      <Text style={{ color: colors.primary }}>{expanded ? '▾' : '▸'} {label}</Text>
    </Pressable>
  );
}

export function NativeToolDisclosure({ message, labels, children }: {
  message: ConversationMessageListProjection;
  labels: NativeAgentChatLabels;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { colors } = useTheme();
  if (!isToolMessage(message) || requiresAttention(message)) return <>{children}</>;
  const activity = readConversationToolActivity(message.metadata?.toolActivity);
  const names = [...new Set(activity.map(item => item.name))];
  if (!names.length) names.push(...new Set(message.presentations?.map(item => item.toolName) ?? []));
  const commentary = hasToolCommentary(message);
  return (
    <View>
      {commentary && children}
      <NativeWorkToggle
        label={names.join(', ') || labels.toolResult}
        expanded={expanded}
        onPress={() => {
          setExpanded(value => !value);
        }}
      />
      {expanded && (
        <View style={{ paddingHorizontal: 10 }}>
          {activity.map((item, index) => (
            <View key={`${item.callId ?? item.name}:${index}`}>
              {(item.input !== undefined || item.inputTruncated) && <Text style={{ color: colors.onSurfaceVariant }}>{labels.toolInput}</Text>}
              {item.input !== undefined && <Text style={{ color: colors.onSurface }}>{item.input}</Text>}
              {item.inputTruncated && <Text style={{ color: colors.onSurfaceVariant }}>{labels.toolInputTruncated}</Text>}
            </View>
          ))}
          {!commentary && children}
        </View>
      )}
    </View>
  );
}
