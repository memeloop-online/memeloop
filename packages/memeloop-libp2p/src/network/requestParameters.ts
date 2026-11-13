export function assertRpcGrantResourceIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('device_grant_run_scope_invalid');
  }
}

export function objectParameter(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_sync_params');
  }
  return value as Record<string, unknown>;
}

export function assertOnlyParameterKeys(
  parameters: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  if (Object.keys(parameters).some(key => !keys.has(key))) {
    throw new Error('invalid_sync_params');
  }
}
