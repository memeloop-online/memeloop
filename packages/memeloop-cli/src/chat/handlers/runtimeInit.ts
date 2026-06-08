import type { ILLMProvider } from "memeloop";
import { createInterface } from "node:readline";
import { createNodeRuntime } from "../../runtime/nodeRuntime.js";
import type { ChatHooks } from "../hooks.js";
import type { ChatHookContext } from "../types.js";

function askProviderNotFound(providerName: string): Promise<"config" | "exit"> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const label = providerName ? `"${providerName}"` : "default";
    console.log(`\n⚠️  No LLM provider found for ${label}.`);
    console.log(`   Run "memeloop config" to add a provider.\n`);
    rl.question("   Open configuration TUI now? [Y/n] ", (answer: string) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
        resolve("config");
      } else {
        console.log("   Skipping. Run memeloop config later to configure a provider.\n");
        resolve("exit");
      }
    });
  });
}

function createPlaceholderProvider(): ILLMProvider {
  return {
    name: "placeholder",
    model: undefined,
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new Error(
        "No LLM provider configured. Run `/config` or `memeloop config` to add a provider.",
      );
    },
  };
}

export function registerRuntimeInitHandler(hooks: ChatHooks) {
  hooks.initRuntime.tapAsync("default", (context, callback) => {
    void initRuntime(context).then(() => {
      callback();
    }, callback);
  });
}

async function initRuntime(context: ChatHookContext): Promise<void> {
  while (true) {
    try {
      context.runtime = createNodeRuntime({
        localNodeId: context.options.localNodeId ?? "memeloop-cli",
        dataDir: context.dataDir,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        config: context.options.config as any,
      });
      return;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Provider not found")) {
        const providerName = message.replace("Provider not found: ", "").trim();
        const answer = await askProviderNotFound(providerName);

        if (answer === "config") {
          try {
            const { launchConfigTUI } = await import("../../providers/ConfigTUI.js");
            await launchConfigTUI();
            continue;
          } catch (configError: unknown) {
            const message_ =
              configError instanceof Error ? configError.message : String(configError);
            console.error("[memeloop] Config TUI failed:", message_);
          }
          continue;
        }

        // User declined — create runtime with placeholder provider
        context.runtime = createNodeRuntime({
          localNodeId: context.options.localNodeId ?? "memeloop-cli",
          dataDir: context.dataDir,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
          config: context.options.config as any,
          llmProvider: createPlaceholderProvider(),
        });
        context.providerMissingHandled = true;
        context.providerMissingAction = "continue";
        return;
      }
      throw error;
    }
  }
}
