# Skills

Core `memeloop` no longer contains a runtime skill registry or plugin skill registration API.

Reusable instructions and capability packs should be distributed as one of:

- built-in or host-provided agent prompt definitions,
- wiki/template content managed by the host application,
- cloud/admin metadata outside the core runtime,
- prompt plugins configured through `agentFrameworkConfig.plugins` when runtime prompt mutation is required.

Current core surfaces related to reusable behavior are:

- `getBuiltinAgentDefinitions()` from `packages/memeloop/src/prompt/loadBuiltins.ts`,
- agent profiles in `packages/memeloop/src/agent/agentProfiles.ts`,
- plugin tools/hooks in `packages/memeloop/src/plugin`,
- prompt utilities/plugins in `packages/memeloop/src/promptUtilities`.

If a future host needs first-class skill composition, keep it outside `memeloop` core until the data model, distribution format, and runtime injection semantics are stable.
