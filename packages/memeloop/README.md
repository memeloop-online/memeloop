# memeloop

Core runtime for MemeLoop: a local-first, multi-agent framework that runs across Desktop, CLI, Mobile, and Cloud.

## What is this package?

`memeloop` provides the shared runtime used by every MemeLoop host:

- **Agent loop framework** (`loopAPI` / `loops`) – ReAct tool-loop and sub-agent orchestration primitives.
- **Loop registry & profiles** – register built-in loops, tool plugins, prompts, and LLM providers, then create a runner for a profile.
- **Storage & sync engine** – SQLite-backed persistence with TiddlyWiki integration and conflict-aware sync.
- **LLM providers** – unified provider entry point over the `ai` SDK (OpenAI, Anthropic, Google, Groq, Ollama, etc.).
- **libp2p networking** – peer discovery, relay, and encrypted channels between nodes.
- **IM adapter** – bridge agents to chat-style interaction.

## Install

```bash
pnpm add memeloop
# or
npm install memeloop
```

## Usage

```ts
import { createAgentLoopRunner, registerBuiltinLoops, registerBuiltinToolPlugins } from "memeloop";

registerBuiltinLoops();
registerBuiltinToolPlugins();

const runner = createAgentLoopRunner({ profileId: "general-assistant" });
```

For LLM provider setup:

```ts
import { createLanguageModel } from "memeloop/llm-providers";

const model = createLanguageModel({
  provider: "openai",
  modelId: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
});
```

## Exports

- `memeloop` – core runtime
- `memeloop/loop-api` – loop primitives and script context types
- `memeloop/llm-providers` – unified LLM provider factory

## Development

```bash
pnpm install
pnpm --filter memeloop build
pnpm --filter memeloop test
```

## License

MIT
