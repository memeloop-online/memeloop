import { getLoadedScriptCheckpointBinding } from '../scriptLoader.js';
import { createScriptStepEmitter, messageStep, yieldScriptResult } from '../scriptRuntime.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopStep } from '../types.js';
import type { AgentToolLoopContext, AgentToolLoopScript, AgentToolLoopScriptContext } from './contracts.js';
import { loadAgentToolLoopScript } from './scriptLoader.js';
import { createAgentToolLoopState, refreshAgentToolLoopDefinition, runAgentToolLoopIteration, startAgentToolLoopTurn, stopAgentToolLoopTurn } from './turnPrimitives.js';

const MISSING_CONTEXT_PROPERTY = Symbol('missing-context-property');

function readContextProperty(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return MISSING_CONTEXT_PROPERTY;
  }
}

function isObjectRecord(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasMethod(value: unknown, key: PropertyKey): boolean {
  return isObjectRecord(value) && typeof readContextProperty(value, key) === 'function';
}

function isToolRegistryLike(value: unknown): boolean {
  if (!isObjectRecord(value) || !hasMethod(value, 'getTool') || !hasMethod(value, 'listTools')) {
    return false;
  }
  for (const key of ['registerTool', 'unregisterTool', 'hasTool', 'getToolParameterSchema', 'getToolMetadata', 'getToolEffect', 'getPromptPlugins'] as const) {
    const candidate = readContextProperty(value, key);
    if (candidate === MISSING_CONTEXT_PROPERTY || (candidate !== undefined && typeof candidate !== 'function')) {
      return false;
    }
  }
  return true;
}

/** Runtime guard for the context handed to agent-tool-loop scripts. */
export function isAgentToolLoopContext(value: unknown): value is AgentToolLoopContext {
  try {
    if (!isObjectRecord(value)) return false;
    const storage = readContextProperty(value, 'storage');
    const llmProvider = readContextProperty(value, 'llmProvider');
    const tools = readContextProperty(value, 'tools');
    const syncAdapters = readContextProperty(value, 'syncAdapters');
    const network = readContextProperty(value, 'network');
    if (
      !isObjectRecord(storage) ||
      !isObjectRecord(llmProvider) ||
      typeof readContextProperty(llmProvider, 'name') !== 'string' ||
      !hasMethod(llmProvider, 'chat') ||
      !isToolRegistryLike(tools) ||
      !Array.isArray(syncAdapters) ||
      !isObjectRecord(network) ||
      !hasMethod(network, 'start') ||
      !hasMethod(network, 'stop')
    ) return false;
    for (const adapter of syncAdapters) {
      if (!isObjectRecord(adapter) || !hasMethod(adapter, 'start') || !hasMethod(adapter, 'stop')) {
        return false;
      }
    }

    const profile = readContextProperty(value, 'profile');
    const runtime = readContextProperty(value, 'runtime');
    const script = readContextProperty(value, 'script');
    const loadScript = readContextProperty(value, 'loadScript');
    const scriptPolicy = readContextProperty(value, 'scriptPolicy');
    if (profile === MISSING_CONTEXT_PROPERTY || (profile !== undefined && !isObjectRecord(profile))) return false;
    if (runtime === MISSING_CONTEXT_PROPERTY || (runtime !== undefined && !isObjectRecord(runtime))) return false;
    if (script === MISSING_CONTEXT_PROPERTY || (script !== undefined && typeof script !== 'function')) return false;
    if (loadScript === MISSING_CONTEXT_PROPERTY || (loadScript !== undefined && typeof loadScript !== 'function')) return false;
    if (scriptPolicy === MISSING_CONTEXT_PROPERTY || (scriptPolicy !== undefined && !isObjectRecord(scriptPolicy))) return false;
    return true;
  } catch {
    return false;
  }
}

export function asAgentToolLoopContext(rawContext: unknown): AgentToolLoopContext {
  if (!isAgentToolLoopContext(rawContext)) {
    throw new TypeError('Agent tool loop context is malformed');
  }
  return rawContext;
}

export async function resolveAgentToolLoopScript(context: AgentToolLoopContext): Promise<AgentToolLoopScript | undefined> {
  if (context.script) return context.script;
  const scriptReference = context.profile?.scriptReference;
  if (!scriptReference) return undefined;
  if (context.loadScript) return context.loadScript(scriptReference, context);
  return loadAgentToolLoopScript(scriptReference, context.scriptPolicy);
}

function createAgentToolLoopScriptContext(
  input: AgentLoopInput,
  context: AgentToolLoopContext,
  emittedSteps: AgentLoopStep[],
): AgentToolLoopScriptContext {
  const emit = createScriptStepEmitter(emittedSteps, context.runtime?.emit);
  return {
    input,
    context,
    profile: context.profile,
    createState: () => createAgentToolLoopState(context),
    startTurn: state => startAgentToolLoopTurn(context, input, state),
    runIteration: state => runAgentToolLoopIteration(context, input, state),
    refreshDefinition: state => refreshAgentToolLoopDefinition(context, input, state),
    stopTurn: (state, reason) => stopAgentToolLoopTurn(context, input, state, reason),
    emit,
    finish: message => {
      emit(typeof message === 'string' ? messageStep(message) : message);
    },
    isCancelled: () =>
      context.runtime?.signal?.cancelled === true ||
      (context.runCancellation?.has(input.runId ?? '') === true) ||
      (context.conversationCancellation?.has(input.conversationId) === true),
    log: (event, data) => {
      context.runtime?.log?.(event, data);
      context.logger?.debug?.(event, data);
    },
  };
}

export async function* runAgentToolLoopScript(
  script: AgentToolLoopScript,
  input: AgentLoopInput,
  context: AgentToolLoopContext,
): AgentLoopGenerator {
  const emittedSteps: AgentLoopStep[] = [];
  const checkpointBinding = getLoadedScriptCheckpointBinding(
    script,
    context.profile,
    input.runId,
  );
  if (checkpointBinding) context.runtime?.bindScriptCheckpoint?.(checkpointBinding);
  const result = await script(createAgentToolLoopScriptContext(input, context, emittedSteps));

  yield* yieldScriptResult(result, emittedSteps);
}
