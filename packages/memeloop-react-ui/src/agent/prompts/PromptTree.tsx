/**
 * PromptTree — read-only presentational tree of agent prompts.
 *
 * Renders a flat list or nested tree display of prompts.
 * No Desktop-store dependency — receives data via props.
 */

import type { PromptNode } from 'memeloop';

import ArrowRightIcon from '@mui/icons-material/ArrowRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Chip, IconButton, Typography } from '@mui/material';
import React, { useState } from 'react';

// ─── Types ─────────────────────────────────────────────────────────

export interface PromptTreeProps {
  /** Flattened list of prompts to display as a tree. */
  prompts: PromptNode[];
  /** Optional callback when a form field path is selected. */
  onFieldSelect?: (fieldPath: string[]) => void;
  /** Localized labels for roles and empty/fallback states. */
  labels?: Partial<PromptTreeLabels>;
}

export interface PromptTreeLabels {
  empty: string;
  prompt: string;
  role: (role: PromptNode['role']) => string;
  expand: string;
  collapse: string;
}

const defaultLabels: PromptTreeLabels = {
  empty: 'No prompts configured',
  prompt: 'Prompt',
  role: role => role ?? '',
  expand: 'Expand',
  collapse: 'Collapse',
};

// ─── Tree node component ───────────────────────────────────────────

interface TreeNodeProps {
  node: PromptNode;
  depth: number;
  fieldPath: string[];
  onFieldSelect?: (fieldPath: string[]) => void;
  labels: PromptTreeLabels;
}

function TreeNode({ node, depth, fieldPath, onFieldSelect, labels }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(node.children?.length);
  const sourcePath = Array.isArray(node.source) ? node.source.map(String) : undefined;
  const selectionPath = sourcePath ?? fieldPath;
  // Section-only presentation nodes such as the generated tool group toggle
  // their children but do not point at an editable array item.
  const isSelectable = selectionPath.length > 1;

  return (
    <Box
      sx={{
        ml: depth > 0 ? depth * 2 : 0,
        mb: 0.5,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          py: 0.5,
          px: 1,
          borderRadius: 1,
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover' },
        }}
        onClick={() => {
          if (hasChildren) setExpanded(!expanded);
          if (onFieldSelect && isSelectable) onFieldSelect(selectionPath);
        }}
      >
        {hasChildren
          ? (
            <IconButton
              size='small'
              edge='start'
              aria-label={expanded ? labels.collapse : labels.expand}
              aria-expanded={expanded}
              data-testid={`prompt-tree-toggle-${node.id}`}
              onClick={(event) => {
                // Expanding a row must not also select it or scroll the editor.
                event.stopPropagation();
                setExpanded(previous => !previous);
              }}
              sx={{ p: 0.25 }}
            >
              {expanded ? <ExpandMoreIcon fontSize='small' /> : <ArrowRightIcon fontSize='small' />}
            </IconButton>
          )
          : <Box sx={{ width: 20 }} />}
        <Chip
          label={labels.role(node.role)}
          size='small'
          variant='outlined'
          color={node.role === 'system' ? 'primary' : 'default'}
          sx={{ minWidth: 60, fontSize: '0.7rem' }}
        />
        <Typography variant='body2' noWrap sx={{ flex: 1 }}>
          {node.caption ?? node.id ?? labels.prompt}
        </Typography>
        {node.text && (
          <Typography
            variant='caption'
            color='text.secondary'
            sx={{
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.text.slice(0, 80)}
            {node.text.length > 80 ? '...' : ''}
          </Typography>
        )}
      </Box>
      {hasChildren && expanded && (
        <Box>
          {node.children!.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              fieldPath={[...fieldPath, child.id]}
              onFieldSelect={onFieldSelect}
              labels={labels}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ─── Main component ────────────────────────────────────────────────

export const PromptTree: React.FC<PromptTreeProps> = ({ prompts, onFieldSelect, labels: labelOverrides }) => {
  const labels = { ...defaultLabels, ...labelOverrides };
  if (!prompts || prompts.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant='body2' color='text.secondary'>
          {labels.empty}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 1 }}>
      {prompts.map(node => (
        <TreeNode
          key={node.id}
          node={node}
          depth={0}
          fieldPath={['prompts', node.id]}
          onFieldSelect={onFieldSelect}
          labels={labels}
        />
      ))}
    </Box>
  );
};
