import { OrchestrationError } from '../errors.js';
import type { AgentWorkloadResource } from '../resources.js';
import type { AgentWorkloadResourceRequirements } from '../resources.js';

const RUNTIME_IMAGE_ANNOTATION = 'memeloop.io/runtime-image';
const RUNTIME_COMMAND_ANNOTATION = 'memeloop.io/runtime-command';
const RUNTIME_ENV_ANNOTATION = 'memeloop.io/runtime-env';
const RUNTIME_CPU_ANNOTATION = 'memeloop.io/runtime-cpu';
const RUNTIME_MEMORY_ANNOTATION = 'memeloop.io/runtime-memory';

export interface ExternalWorkloadRuntimeContract {
  /** Matches `AgentWorkload.spec.runtimeClass`; `default` matches omission. */
  runtimeClass: string;
  /** Host-selected image. Production deployments should pin a manifest digest. */
  image: string;
  /** Host-selected entrypoint override, if the image default is insufficient. */
  command?: string[];
  /** Host-selected non-secret container environment. */
  environment?: Record<string, string>;
  /** Default and maximum enforced CPU/memory allocation. */
  resources: {
    cpuMillicores: number;
    memoryBytes: number;
  };
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertExternalWorkloadRuntimeContracts(
  contracts: readonly ExternalWorkloadRuntimeContract[],
): void {
  const classes = new Set<string>();
  for (const contract of contracts) {
    if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
      invalid('external workload runtime contract must be an object');
    }
    if (
      typeof contract.runtimeClass !== 'string' ||
      contract.runtimeClass.length === 0 ||
      typeof contract.image !== 'string' ||
      contract.image.length === 0
    ) {
      invalid('external workload runtime contracts require runtimeClass and image');
    }
    if (
      !Number.isSafeInteger(contract.resources?.cpuMillicores) ||
      contract.resources.cpuMillicores < 1 ||
      !Number.isSafeInteger(contract.resources?.memoryBytes) ||
      contract.resources.memoryBytes < 1
    ) {
      invalid(
        `external workload runtimeClass '${contract.runtimeClass}' requires positive safe CPU/memory limits`,
      );
    }
    if (classes.has(contract.runtimeClass)) {
      invalid(`external workload runtimeClass '${contract.runtimeClass}' is duplicated`);
    }
    classes.add(contract.runtimeClass);
    if (
      (
        contract.command !== undefined &&
        (
          !Array.isArray(contract.command) ||
          contract.command.some((argument) => typeof argument !== 'string')
        )
      ) ||
      (
        contract.environment !== undefined &&
        !isRecord(contract.environment)
      ) ||
      Object.entries(contract.environment ?? {}).some(([key, value]) => !key || typeof value !== 'string' || key.startsWith('MEMELOOP_'))
    ) {
      invalid(`external workload runtimeClass '${contract.runtimeClass}' has invalid command or environment`);
    }
  }
}

/**
 * Resolve only host-published runtime configuration. Legacy annotations are
 * rejected because they let a workload replace the trusted worker process.
 */
export function resolveExternalWorkloadRuntime(
  workload: AgentWorkloadResource,
  contracts: readonly ExternalWorkloadRuntimeContract[] | undefined,
): ExternalWorkloadRuntimeContract {
  const annotations = workload.metadata.annotations;
  if (
    annotations?.[RUNTIME_IMAGE_ANNOTATION] !== undefined ||
    annotations?.[RUNTIME_COMMAND_ANNOTATION] !== undefined ||
    annotations?.[RUNTIME_ENV_ANNOTATION] !== undefined ||
    annotations?.[RUNTIME_CPU_ANNOTATION] !== undefined ||
    annotations?.[RUNTIME_MEMORY_ANNOTATION] !== undefined
  ) {
    invalid(
      'AgentWorkload runtime image, command, container environment, and resources are host-owned; select spec.runtimeClass and spec.resources instead',
    );
  }
  const runtimeClass = workload.spec.runtimeClass ?? 'default';
  const matches = (contracts ?? []).filter((candidate) => candidate.runtimeClass === runtimeClass);
  if (matches.length !== 1) {
    invalid(`AgentWorkload runtimeClass '${runtimeClass}' has no unique trusted external runtime`);
  }
  return matches[0];
}

/** Apply host maxima and safe defaults to portable workload requirements. */
export function resolveExternalWorkloadResources(
  workload: AgentWorkloadResource,
  contract: ExternalWorkloadRuntimeContract,
): AgentWorkloadResourceRequirements {
  const requested = workload.spec.resources;
  if (
    (requested?.gpuCount ?? 0) > 0 ||
    (requested?.diskBytes ?? 0) > 0 ||
    (requested?.bandwidthKbps ?? 0) > 0
  ) {
    invalid(
      `external runtimeClass '${contract.runtimeClass}' does not implement GPU, disk, or bandwidth isolation`,
    );
  }
  const cpuMillicores = requested?.cpuMillicores ??
    contract.resources.cpuMillicores;
  const memoryBytes = requested?.memoryBytes ?? contract.resources.memoryBytes;
  if (
    !Number.isSafeInteger(cpuMillicores) ||
    cpuMillicores < 1 ||
    cpuMillicores > contract.resources.cpuMillicores ||
    !Number.isSafeInteger(memoryBytes) ||
    memoryBytes < 1 ||
    memoryBytes > contract.resources.memoryBytes
  ) {
    invalid(
      `AgentWorkload resources exceed the host contract for runtimeClass '${contract.runtimeClass}'`,
    );
  }
  return { cpuMillicores, memoryBytes };
}
