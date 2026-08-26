/**
 * Node/default host adapter for deployable Agent loop modules.
 *
 * Keep the variable dynamic import isolated in this module. Portable builds
 * replace this adapter at build time, so Metro never has to parse or transform
 * a runtime-selected module specifier.
 */
export async function nodeAgentLoopModuleImporter(specifier: string): Promise<unknown> {
  return import(specifier);
}

export const defaultAgentLoopModuleImporter = nodeAgentLoopModuleImporter;
