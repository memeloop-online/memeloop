import type { SubAgentLoopScript } from './loop.js';

export interface LoadSubAgentLoopScriptOptions {
  importModule?: (specifier: string) => Promise<unknown>;
}

function getExportedScript(moduleExports: unknown): unknown {
  if (typeof moduleExports === 'function') return moduleExports;
  if (!moduleExports || typeof moduleExports !== 'object') return undefined;

  const record = moduleExports as Record<string, unknown>;
  return record.default ?? record.run;
}

export async function loadSubAgentLoopScript(
  scriptSpecifier: string,
  options: LoadSubAgentLoopScriptOptions = {},
): Promise<SubAgentLoopScript> {
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));
  const moduleExports: unknown = await importModule(scriptSpecifier);
  const exportedScript = getExportedScript(moduleExports);

  if (typeof exportedScript !== 'function') {
    throw new TypeError(
      `SubAgent loop script "${scriptSpecifier}" must export a default function or named run function.`,
    );
  }

  return exportedScript as SubAgentLoopScript;
}
