const PUBLIC_RPC_ERROR_CODES = new Set([
  'device_grant_rpc_scope_violation',
  'device_grant_run_conversation_mismatch',
  'device_grant_run_definition_mismatch',
  'device_grant_run_peer_mismatch',
  'device_grant_run_scope_invalid',
  'device_grant_run_scope_unavailable',
  'device_not_trusted',
  'invalid_rpc_params',
  'invalid_rpc_request',
  'rpc_collection_scope_violation',
  'rpc_handler_not_configured',
  'rpc_method_not_found',
  'rpc_permission_denied',
  'rpc_resource_not_found',
]);

export function rpcErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const unscopedCode = message.split(':', 1)[0] ?? '';
  return PUBLIC_RPC_ERROR_CODES.has(unscopedCode)
    ? unscopedCode
    : 'rpc_handler_failed';
}

export function syncErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid canonical conversation event')) return 'invalid_sync_events';
  if (message.startsWith('Invalid typed JSON value')) return 'invalid_sync_response';
  return /^[a-z][a-z\d_]{0,63}$/u.test(message) ? message : 'sync_request_failed';
}
