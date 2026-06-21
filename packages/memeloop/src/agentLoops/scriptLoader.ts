import type { AgentLoopScriptPolicy, LoopProfileScriptReference } from './types.js';

export type AgentLoopScriptReference = string | LoopProfileScriptReference;

export interface LoadAgentLoopScriptOptions extends AgentLoopScriptPolicy {
  getBuiltinScriptSource?: (id: string) => string | undefined;
  scriptType?: string;
}

const DEFAULT_POLICY = {
  allowBuiltin: true,
  allowFile: false,
  allowNetwork: false,
  allowSource: false,
  allowSpecifier: true,
} as const;

function getExportedScript(moduleExports: unknown): unknown {
  if (typeof moduleExports === 'function') return moduleExports;
  if (!moduleExports || typeof moduleExports !== 'object') return undefined;

  const record = moduleExports as Record<string, unknown>;
  return record.default ?? record.run;
}

function sourceToDataSpecifier(source: string, name = 'agent-loop-script.mjs'): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(`${source}\n//# sourceURL=${name}`)}`;
}

function normalizeScriptReference(scriptReference: AgentLoopScriptReference): LoopProfileScriptReference {
  if (typeof scriptReference !== 'string') return scriptReference;
  if (scriptReference.startsWith('builtin:')) return { kind: 'builtin', id: scriptReference };
  return { kind: 'specifier', specifier: scriptReference };
}

function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith('file:') || specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../');
}

function isNetworkSpecifier(specifier: string): boolean {
  return specifier.startsWith('http:') || specifier.startsWith('https:');
}

function isSourceSpecifier(specifier: string): boolean {
  return specifier.startsWith('data:text/javascript') || specifier.startsWith('data:application/javascript');
}

function assertSpecifierAllowed(specifier: string, policy: Required<Pick<LoadAgentLoopScriptOptions, 'allowFile' | 'allowNetwork' | 'allowSource' | 'allowSpecifier'>>): void {
  if (!policy.allowSpecifier) {
    throw new Error('Agent loop script import specifiers are disabled by policy.');
  }
  if (isSourceSpecifier(specifier) && !policy.allowSource) {
    throw new Error('Agent loop script source/data URLs are disabled by policy.');
  }
  if (isFileSpecifier(specifier) && !policy.allowFile) {
    throw new Error('Agent loop script file imports are disabled by policy.');
  }
  if (isNetworkSpecifier(specifier) && !policy.allowNetwork) {
    throw new Error('Agent loop script network imports are disabled by policy.');
  }
}

export async function loadAgentLoopScript<TScript>(
  scriptReference: AgentLoopScriptReference,
  options: LoadAgentLoopScriptOptions = {},
): Promise<TScript> {
  const policy = { ...DEFAULT_POLICY, ...options };
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));
  const normalized = normalizeScriptReference(scriptReference);
  const scriptType = options.scriptType ?? 'Agent loop script';
  let scriptSpecifier: string;
  let isBuiltinScript = false;

  if (normalized.kind === 'builtin') {
    if (!policy.allowBuiltin) {
      throw new Error('Built-in agent loop scripts are disabled by policy.');
    }
    const source = options.getBuiltinScriptSource?.(normalized.id);
    if (!source) throw new Error(`Unknown built-in agent loop script: ${normalized.id}`);
    scriptSpecifier = sourceToDataSpecifier(source, normalized.id);
    isBuiltinScript = true;
  } else if (normalized.kind === 'source') {
    if (!policy.allowSource) {
      throw new Error('Agent loop script source strings are disabled by policy.');
    }
    scriptSpecifier = sourceToDataSpecifier(normalized.source, normalized.name);
  } else {
    scriptSpecifier = normalized.specifier;
  }

  if (!isBuiltinScript) {
    assertSpecifierAllowed(scriptSpecifier, policy);
  }
  const moduleExports: unknown = await importModule(scriptSpecifier);
  const exportedScript = getExportedScript(moduleExports);

  if (typeof exportedScript !== 'function') {
    throw new TypeError(
      `${scriptType} "${scriptSpecifier}" must export a default function or named run function.`,
    );
  }

  return exportedScript as TScript;
}
