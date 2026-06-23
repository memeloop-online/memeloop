/**
 * PermissionDialog — 权限确认弹窗（对标 Claude Code PermissionRequest）
 */
import { Box, Text } from 'ink';
import React from 'react';
import type { PermissionRequest } from './types.js';

interface Props {
  request: PermissionRequest;
  onApprove: () => void;
  onDeny: () => void;
}

export function PermissionDialog({ request, onApprove: _onApprove, onDeny: _onDeny }: Props) {
  return (
    <Box
      flexDirection='column'
      borderStyle='round'
      borderColor='yellow'
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text bold color='yellow'>
        ⚠ Permission Required
      </Text>
      <Text>{request.message}</Text>
      <Box marginTop={1}>
        <Text>
          Tool: <Text color='blue'>{request.toolName}</Text>
        </Text>
      </Box>
      {Object.keys(request.toolInput).length > 0 && (
        <Box flexDirection='column' marginTop={1}>
          <Text dimColor>Parameters:</Text>
          {Object.entries(request.toolInput).map(([k, v]) => (
            <Text key={k} dimColor>
              {' '}
              {k}: {JSON.stringify(v)}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          Press <Text color='green' bold>y</Text> to allow, <Text color='red' bold>n</Text> to deny
          {request.actions.includes('always') && (
            <>
              , <Text color='green' bold>a</Text> to always allow
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}
