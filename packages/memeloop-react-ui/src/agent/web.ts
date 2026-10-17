/** Browser-only AgentSession bindings. This entrypoint intentionally exposes DOM File. */
export {
  createBrowserFileAttachmentSource,
  MAX_BROWSER_FILE_ATTACHMENT_BYTES,
  MAX_BROWSER_FILE_ATTACHMENT_FILENAME_BYTES,
  MAX_BROWSER_FILE_ATTACHMENT_MIME_TYPE_BYTES,
} from './browserFileAttachment.js';
export { useAgentSessionChatAdapter } from './useAgentSessionChatAdapter.js';
export type { AgentSessionChatAdapterOptions } from './useAgentSessionChatAdapter.js';
