/** Stable fail-closed error for platforms without deployable module loading. */
export class AgentLoopModuleImportUnavailableError extends Error {
  readonly code = 'AGENT_LOOP_MODULE_IMPORT_UNAVAILABLE' as const;

  constructor(readonly specifier: string) {
    super(
      `Agent loop module importing is unavailable on this platform: ${specifier}`,
    );
    this.name = 'AgentLoopModuleImportUnavailableError';
  }
}

/**
 * React Native default adapter. First-party builtin loops use a static module
 * map and never reach this function; external/source modules fail closed.
 */
export async function mobileAgentLoopModuleImporter(specifier: string): Promise<never> {
  throw new AgentLoopModuleImportUnavailableError(specifier);
}

export const defaultAgentLoopModuleImporter = mobileAgentLoopModuleImporter;
