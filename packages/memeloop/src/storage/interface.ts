export type {
  AgentInstanceStore,
  BlobStore,
  ConversationDirectoryStore,
  ConversationEventStore,
  ConversationQueryMode,
  DefinitionStore,
  FullAgentStorage,
  GetMessagesOptions,
  ImBindingStore,
  ListConversationsOptions,
} from './ports.js';

import type { FullAgentStorage } from './ports.js';

/**
 * Monolithic storage facade (legacy shape: every port combined). Prefer the
 * narrow ports in `./ports.js` for new code so hosts can implement only the
 * capabilities they actually have.
 */
export type IAgentStorage = FullAgentStorage;
