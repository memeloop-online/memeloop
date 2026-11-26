import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { OrchestrationError } from '../errors.js';
import type { ToolOperationEffect, ToolOperationResource } from '../resources.js';

export interface ExternalToolContract {
  /** Exact portable tool identity implemented by the external runtime. */
  kind: string;
  name: string;
  /** Host-authoritative effect. A caller cannot downgrade this value. */
  effect: ToolOperationEffect;
  /** Portable JSON Schema applied without coercion, defaults, or field removal. */
  inputSchema: Record<string, unknown>;
  /** Portable JSON Schema for the untrusted runtime's returned value. */
  outputSchema: Record<string, unknown>;
  /** Optional content digest callers may pin through `toolRef.schemaDigest`. */
  schemaDigest?: string;
  /** Host-owned hard resource ceiling for the one-shot executor. */
  resources: {
    cpuMillicores: number;
    memoryBytes: number;
  };
  /** Exact immutable/tagged image references admitted to implement this contract. */
  runtimeImages: string[];
}

const validatorOptions = {
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: false,
  useDefaults: false,
  validateFormats: false,
} as const;
const TOOL_EFFECTS = new Set<ToolOperationEffect>([
  'read',
  'create',
  'update',
  'delete',
  'execute',
  'unknown',
]);

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function compilerFor(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  switch (schema.$schema) {
    case undefined:
    case 'http://json-schema.org/draft-07/schema#':
    case 'https://json-schema.org/draft-07/schema#': {
      return new Ajv(validatorOptions);
    }
    case 'https://json-schema.org/draft/2019-09/schema': {
      return new Ajv2019(validatorOptions);
    }
    case 'https://json-schema.org/draft/2020-12/schema': {
      return new Ajv2020(validatorOptions);
    }
    default: {
      invalid(`external tool contract uses unsupported schema draft '${String(schema.$schema)}'`);
    }
  }
}

function compileSchema(
  contract: ExternalToolContract,
  schema: Record<string, unknown>,
  direction: 'input' | 'output',
): ValidateFunction {
  if (
    typeof contract.kind !== 'string' ||
    contract.kind.length === 0 ||
    typeof contract.name !== 'string' ||
    contract.name.length === 0 ||
    !TOOL_EFFECTS.has(contract.effect) ||
    !Array.isArray(contract.runtimeImages) ||
    contract.runtimeImages.length === 0 ||
    contract.runtimeImages.some((image) => typeof image !== 'string' || image.length === 0) ||
    !contract.resources ||
    !Number.isSafeInteger(contract.resources.cpuMillicores) ||
    contract.resources.cpuMillicores < 1 ||
    !Number.isSafeInteger(contract.resources.memoryBytes) ||
    contract.resources.memoryBytes < 1
  ) {
    invalid(`external tool contract '${contract.name}' is incomplete`);
  }
  try {
    return compilerFor(schema).compile(schema);
  } catch {
    invalid(`external tool contract '${contract.name}' has an invalid ${direction} schema`);
  }
}

/** Validate a driver-published catalog once at construction/discovery time. */
export function assertExternalToolContracts(
  contracts: readonly ExternalToolContract[],
): void {
  const identities = new Set<string>();
  for (const contract of contracts) {
    if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
      invalid('external tool contract must be an object');
    }
    const identity = `${contract.kind}\0${contract.name}`;
    if (identities.has(identity)) {
      invalid(`external tool contract '${contract.kind}/${contract.name}' is duplicated`);
    }
    identities.add(identity);
    compileSchema(contract, contract.inputSchema, 'input');
    compileSchema(contract, contract.outputSchema, 'output');
  }
}

/**
 * Bind an externally placed operation to the driver/runtime's trusted
 * declaration before any native API call or adoption lookup.
 */
export function assertExternalToolOperationContract(
  operation: ToolOperationResource,
  contracts: readonly ExternalToolContract[] | undefined,
  runtimeImage: string | undefined,
): ExternalToolContract {
  const matches = (contracts ?? []).filter((candidate) =>
    candidate.kind === operation.spec.toolRef.kind &&
    candidate.name === operation.spec.toolRef.name
  );
  if (matches.length !== 1) {
    invalid(
      `external tool '${operation.spec.toolRef.kind}/${operation.spec.toolRef.name}' has no unique trusted runtime contract`,
    );
  }
  const contract = matches[0];
  if (operation.spec.effect !== contract.effect) {
    invalid(
      `external tool '${contract.name}' effect '${operation.spec.effect}' does not match host contract '${contract.effect}'`,
    );
  }
  if (
    operation.spec.toolRef.schemaDigest !== undefined &&
    operation.spec.toolRef.schemaDigest !== contract.schemaDigest
  ) {
    invalid(`external tool '${contract.name}' schema digest does not match the host contract`);
  }
  if (runtimeImage !== undefined && !contract.runtimeImages.includes(runtimeImage)) {
    invalid(`runtime image '${runtimeImage}' is not admitted for external tool '${contract.name}'`);
  }
  const validate = compileSchema(contract, contract.inputSchema, 'input');
  if (!validate(operation.spec.arguments ?? {})) {
    invalid(`external tool '${contract.name}' arguments do not match the host contract`);
  }
  return contract;
}

/** Validate the value returned by an external runtime before persistence. */
export function assertExternalToolOperationResult(
  contract: ExternalToolContract,
  value: unknown,
): void {
  const validate = compileSchema(contract, contract.outputSchema, 'output');
  if (!validate(value)) {
    invalid(`external tool '${contract.name}' result does not match the host contract`);
  }
}

/** Contracts implemented by the bundled minimal worker-runtime image. */
export function createMinimalExternalRuntimeToolContracts(runtimeImage: string): ExternalToolContract[] {
  return [{
    kind: 'Tool',
    name: 'memeloop.runtime.health',
    effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { healthy: { type: 'boolean' } },
      required: ['healthy'],
      additionalProperties: false,
    },
    resources: { cpuMillicores: 500, memoryBytes: 256 * 1024 * 1024 },
    runtimeImages: [runtimeImage],
  }, {
    kind: 'Tool',
    name: 'memeloop.runtime.echo',
    effect: 'read',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    resources: { cpuMillicores: 500, memoryBytes: 256 * 1024 * 1024 },
    runtimeImages: [runtimeImage],
  }];
}
