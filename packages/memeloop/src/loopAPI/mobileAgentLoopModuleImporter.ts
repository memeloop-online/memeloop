/** Stable capability error for platforms that require a host-provided module importer. */
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
 * map; external/source modules report that a host-provided importer is required.
 */
export async function mobileAgentLoopModuleImporter(specifier: string): Promise<never> {
  throw new AgentLoopModuleImportUnavailableError(specifier);
}

export const defaultAgentLoopModuleImporter = mobileAgentLoopModuleImporter;
