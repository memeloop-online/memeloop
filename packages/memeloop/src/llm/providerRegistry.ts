import type { ILLMProvider } from "../types.js";

export interface ProviderConfig {
  name: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface RegisteredProvider {
  provider: ILLMProvider;
  config: ProviderConfig;
}

export class ProviderRegistry {
  private providers = new Map<string, RegisteredProvider>();

  register(provider: ILLMProvider, config?: Omit<ProviderConfig, "name">): void {
    this.providers.set(provider.name, {
      provider,
      config: {
        name: provider.name,
        baseUrl: config?.baseUrl,
        apiKey: config?.apiKey,
      },
    });
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  get(name: string): ILLMProvider | undefined {
    return this.providers.get(name)?.provider;
  }

  getConfig(name: string): ProviderConfig | undefined {
    return this.providers.get(name)?.config;
  }

  upsertConfig(config: ProviderConfig): void {
    const existing = this.providers.get(config.name);
    if (!existing) {
      throw new Error(`Provider not found: ${config.name}`);
    }
    this.providers.set(config.name, {
      provider: existing.provider,
      config: {
        name: config.name,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      },
    });
  }

  list(): string[] {
    return Array.from(this.providers.keys()).sort();
  }

  listConfigs(): ProviderConfig[] {
    return this.list().map((name) => {
      const config = this.providers.get(name)?.config;
      if (!config) {
        throw new Error(`Provider config missing: ${name}`);
      }
      return { ...config };
    });
  }

  resolve(modelId: string): { provider: ILLMProvider; providerName: string; modelName?: string } {
    const [providerName, ...rest] = modelId.split("/");
    const registered = this.providers.get(providerName);
    if (!registered) {
      throw new Error(`Provider not found: ${providerName}`);
    }
    return {
      provider: registered.provider,
      providerName,
      modelName: rest.length > 0 ? rest.join("/") : undefined,
    };
  }

}
