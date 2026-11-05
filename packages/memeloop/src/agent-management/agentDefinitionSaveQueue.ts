import type { AgentDefinition } from '../agent/types.js';

type SaveAgentDefinition = (definition: AgentDefinition) => Promise<AgentDefinition>;

export interface IAgentDefinitionSaveQueue {
  save(definition: AgentDefinition, persist?: SaveAgentDefinition): Promise<AgentDefinition>;
  waitForIdle(): Promise<void>;
}

/**
 * Serialize agent-definition writes so an older IPC request can never finish
 * after a newer request and overwrite it. A rejected save does not block later
 * writes from running.
 */
export function createAgentDefinitionSaveQueue(saveAgentDefinition: SaveAgentDefinition): IAgentDefinitionSaveQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    save(definition: AgentDefinition, persist = saveAgentDefinition): Promise<AgentDefinition> {
      const result = tail.then(async () => await persist(definition));
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    waitForIdle(): Promise<void> {
      return tail;
    },
  };
}
