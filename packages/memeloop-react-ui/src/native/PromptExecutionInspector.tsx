import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { BackHandler, Platform, Pressable, Text, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import {
  buildPromptInspectionFlat,
  buildPromptInspectionTree,
  defaultPromptExecutionInspectorLabels,
  type PromptExecutionInspectorLabels,
  type PromptExecutionInspectorProps,
  type PromptInspectionNode,
} from '../agent/promptInspection.js';
import { usePromptExecutionInspection } from '../agent/usePromptExecutionInspection.js';

function TreeBranch({ node, labels, onEntry, onFieldSelect }: {
  node: PromptInspectionNode;
  labels: PromptExecutionInspectorLabels;
  onEntry: (node: PromptInspectionNode) => void;
  onFieldSelect?: (paths: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { colors } = useTheme();
  if (node.gap) return <Text style={{ color: colors.onSurface }}>… {node.gap.first}–{node.gap.last} …</Text>;
  if (node.entry) {
    return (
      <Pressable
        testID={`prompt-entry-${node.entry.entryIndex}`}
        accessibilityRole='button'
        onPress={() => {
          onEntry(node);
        }}
        style={{ padding: 12, marginVertical: 4, borderWidth: 1, borderRadius: 8, borderColor: colors.outline }}
      >
        <Text style={{ color: colors.onSurface }}>{labels.role(node.entry.role)} · {labels.source(node.entry.source)}</Text>
        <Text style={{ color: colors.onSurface }}>{node.entry.preview || labels.empty}</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ paddingLeft: 12, borderLeftWidth: 1, borderColor: colors.outline }}>
      <Pressable
        accessibilityRole='button'
        accessibilityState={{ expanded }}
        onPress={() => {
          setExpanded(!expanded);
        }}
        style={{ paddingVertical: 10 }}
      >
        <Text style={{ color: colors.onSurface }}>{expanded ? '▾ ' : '▸ '}{node.source ? labels.source(node.source) : node.caption}</Text>
      </Pressable>
      {node.fieldPaths?.length && onFieldSelect
        ? (
          <Pressable
            accessibilityRole='button'
            onPress={() => {
              onFieldSelect(node.fieldPaths!);
            }}
          >
            <Text style={{ color: colors.primary }}>{labels.editSource}</Text>
          </Pressable>
        )
        : null}
      {expanded && node.children.map(child => <TreeBranch key={child.key} node={child} labels={labels} onEntry={onEntry} onFieldSelect={onFieldSelect} />)}
    </View>
  );
}

export interface NativePromptExecutionInspectorHandle {
  /** Returns true when an open detail consumed Back; otherwise the host may close its modal. */
  handleBack(): boolean;
}

export const NativePromptExecutionInspector = forwardRef<NativePromptExecutionInspectorHandle, PromptExecutionInspectorProps>(
  function NativePromptExecutionInspector(props, reference) {
    const labels = { ...defaultPromptExecutionInspectorLabels, ...props.labels };
    const { colors } = useTheme();
    const [localView, setLocalView] = useState<'tree' | 'flat'>('tree');
    const view = props.view ?? localView;
    const state = usePromptExecutionInspection(props);
    const detailOpen = state.detail !== undefined;
    const handleBack = useCallback(() => {
      if (!detailOpen) return false;
      state.closeDetail();
      return true;
    }, [detailOpen, state.closeDetail]);
    useImperativeHandle(reference, () => ({ handleBack }), [handleBack]);
    useEffect(() => {
      if (!detailOpen) return;
      const subscription = BackHandler.addEventListener('hardwareBackPress', handleBack);
      return () => {
        subscription.remove();
      };
    }, [detailOpen, handleBack]);
    const action = (text: string, onPress: () => void, disabled = false, testID?: string) => (
      <Pressable
        accessibilityRole='button'
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        testID={testID}
        style={{ padding: 12, opacity: disabled ? 0.5 : 1 }}
      >
        <Text style={{ color: colors.primary }}>{text}</Text>
      </Pressable>
    );
    const onEntry = (node: PromptInspectionNode) => {
      const entry = node.entry!;
      void state.loadDetail({ kind: 'entry', entryId: entry.entryId, entryIndex: entry.entryIndex });
    };
    return (
      <View
        testID='prompt-execution-inspector'
        style={{ gap: 8 }}
        {...(Platform.OS === 'web'
          ? {
            onKeyDown: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
              if (event.key === 'Escape' && detailOpen) {
                event.preventDefault();
                event.stopPropagation();
                state.closeDetail();
              }
            },
          }
          : {})}
      >
        <Text style={{ color: colors.onSurface }}>{props.audit.route.providerId} · {props.audit.route.logicalModelId}</Text>
        {action(
          labels.request,
          () => void state.loadDetail({ kind: 'request' }),
          false,
          'prompt-preview-model-request-detail',
        )}
        <View style={{ flexDirection: 'row' }}>
          {(['tree', 'flat'] as const).map(next => (
            <Pressable
              key={next}
              accessibilityRole='tab'
              accessibilityState={{ selected: view === next }}
              onPress={() => {
                state.closeDetail();
                setLocalView(next);
                props.onViewChange?.(next);
              }}
              style={{ flex: 1, padding: 12, borderBottomWidth: view === next ? 2 : 0, borderColor: colors.primary }}
            >
              <Text style={{ color: colors.onSurface }}>{labels[next]}</Text>
            </Pressable>
          ))}
        </View>
        {state.detail
          ? (
            <View testID='prompt-preview-audit-detail'>
              {action(labels.back, state.closeDetail, false, 'prompt-preview-detail-back')}
              {state.loading && <Text style={{ color: colors.onSurface }}>{labels.loading}</Text>}
              <Text selectable style={{ color: colors.onSurface }}>{state.detail.text}</Text>
              {state.detail.nextCursor && action(labels.later, () => void state.loadDetail(state.detail!.target, state.detail!.nextCursor), state.loading)}
            </View>
          )
          : null}
        <View style={{ display: detailOpen ? 'none' : 'flex' }} accessibilityElementsHidden={detailOpen} importantForAccessibility={detailOpen ? 'no-hide-descendants' : 'auto'}>
          {(view === 'tree' ? buildPromptInspectionTree(state.page.items) : buildPromptInspectionFlat(state.page.items))
            .map(node => <TreeBranch key={node.key} node={node} labels={labels} onEntry={onEntry} onFieldSelect={props.onFieldSelect} />)}
          {state.page.items.length === 0 && <Text style={{ color: colors.onSurface }}>{labels.empty}</Text>}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {action(labels.earlier, () => void state.loadPage('before'), !state.page.hasMoreBefore || state.loading)}
            <Text style={{ color: colors.onSurface }}>{state.page.items.length} / {state.page.totalEntries}</Text>
            {action(labels.later, () => void state.loadPage('after'), !state.page.hasMoreAfter || state.loading)}
          </View>
        </View>
        {state.error && <Text accessibilityRole='alert' style={{ color: colors.error }}>{labels.error}</Text>}
      </View>
    );
  },
);
