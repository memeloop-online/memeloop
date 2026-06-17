/**
 * PromptTree — read-only presentational tree of agent prompts.
 *
 * Renders a flat list or nested tree display of prompts.
 * No Desktop-store dependency — receives data via props.
 */

import type { PromptNode } from 'memeloop';

import ArrowRightIcon from '@mui/icons-material/ArrowRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Chip, Typography } from '@mui/material';
import React, { useState } from 'react';

// ─── Types ─────────────────────────────────────────────────────────

export interface PromptTreeProps {
  /** Flattened list of prompts to display as a tree. */
  prompts: PromptNode[];
  /** Optional callback when a form field path is selected. */
  onFieldSelect?: (fieldPath: string[]) => void;
}

// ─── Tree node component ───────────────────────────────────────────

interface TreeNodeProps {
  node: PromptNode;
  depth: number;
  fieldPath: string[];
  onFieldSelect?: (fieldPath: string[]) => void;
}

function TreeNode({ node, depth, fieldPath, onFieldSelect }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children && node.children.length > 0;

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
          if (onFieldSelect) {
            const sourcePath = (node as unknown as { source?: unknown }).source;
            onFieldSelect(Array.isArray(sourcePath) ? sourcePath.map(String) : fieldPath);
          }
        }}
      >
        {hasChildren
          ? (
            expanded ? <ExpandMoreIcon fontSize='small' /> : <ArrowRightIcon fontSize='small' />
          )
          : <Box sx={{ width: 20 }} />}
        <Chip
          label={node.role}
          size='small'
          variant='outlined'
          color={node.role === 'system' ? 'primary' : 'default'}
          sx={{ minWidth: 60, fontSize: '0.7rem' }}
        />
        <Typography variant='body2' noWrap sx={{ flex: 1 }}>
          {(node as unknown as Record<string, unknown>).caption as string ?? (node as unknown as Record<string, unknown>).id as string ?? 'Prompt'}
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
          {node.children!.map((child, index) => (
            <TreeNode
              key={(child as unknown as Record<string, unknown>).id as string ?? index}
              node={child}
              depth={depth + 1}
              fieldPath={[...fieldPath, String((child as unknown as { id?: string })?.id ?? index)]}
              onFieldSelect={onFieldSelect}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ─── Main component ────────────────────────────────────────────────

export const PromptTree: React.FC<PromptTreeProps> = ({ prompts, onFieldSelect }) => {
  if (!prompts || prompts.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant='body2' color='text.secondary'>
          No prompts configured
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 1 }}>
      {prompts.map((node, index) => (
        <TreeNode
          key={(node as unknown as Record<string, unknown>).id as string ?? index}
          node={node}
          depth={0}
          fieldPath={['prompts', String((node as unknown as { id?: string })?.id ?? index)]}
          onFieldSelect={onFieldSelect}
        />
      ))}
    </Box>
  );
};
