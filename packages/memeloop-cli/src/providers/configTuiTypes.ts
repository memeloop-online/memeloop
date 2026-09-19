import type { ModelCatalogProvider, ProviderModelRoute } from 'memeloop';

import type { PresetProvider } from './presets.js';
import type { ProviderInfo } from './providerStore.js';

export type ConfigView =
  | 'main'
  | 'add_preset'
  | 'add_manual'
  | 'edit'
  | 'import_text'
  | 'export_show'
  | 'delete_confirm'
  | 'node'
  | 'cloud';

export interface EditState {
  readonly origProviderId: string;
  readonly providerId: string;
  readonly providerType: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fieldIndex: number;
}

export interface ConfigTuiState {
  readonly view: ConfigView;
  readonly providers: readonly ProviderInfo[];
  readonly selectedIndex: number;
  readonly message: string;
  readonly presets: readonly PresetProvider[];
  readonly presetIndex: number;
  readonly addName: string;
  readonly addBaseUrl: string;
  readonly addApiKey: string;
  readonly addModels: readonly ProviderModelRoute[];
  readonly addCatalogProvider?: ModelCatalogProvider;
  readonly addFieldIndex: number;
  readonly editState: EditState | null;
  readonly importText: string;
  readonly exportData: string;
  readonly nodeStatus: Readonly<Record<string, string>>;
  readonly cloudUrl: string;
  readonly cloudAccessToken: string;
  readonly cloudFieldIndex: number;
  readonly cloudSaving: boolean;
}
