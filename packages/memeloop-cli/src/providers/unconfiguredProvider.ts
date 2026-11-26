import type { ILLMProvider } from 'memeloop';

import type { NodeConfig } from '../config.js';

export const UNCONFIGURED_PROVIDER_ERROR = 'No LLM provider configured. Run `/config` or `memeloop config` to add a provider.';

/**
 * Keep non-model services available before onboarding has configured a
 * provider. The first actual model request fails explicitly and never falls
 * back to an unintended provider or credential source.
 */
export function createUnconfiguredLLMProvider(): ILLMProvider {
  return {
    name: 'unconfigured',
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new Error(UNCONFIGURED_PROVIDER_ERROR);
    },
  };
}

/**
 * A fresh remote node must be able to start its device-network and
 * orchestration services before the owner selects an LLM provider. Do not
 * advertise a fake ModelEndpoint or start a ModelGateway in that state.
 */
export function resolveUnconfiguredDaemonModelRuntime(
  config: Pick<NodeConfig, 'providers'>,
) {
  if ((config.providers?.length ?? 0) > 0) return undefined;
  return {
    llmProvider: createUnconfiguredLLMProvider(),
    modelEndpointRegistration: { enabled: false },
    modelGateway: { enabled: false },
  } as const;
}
