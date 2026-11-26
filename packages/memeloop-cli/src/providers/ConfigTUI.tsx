/**
 * ConfigTUI.tsx — Interactive provider configuration TUI (Ink v5 + React v18).
 * ConfigTUI.tsx — 交互式 Provider 配置 TUI。
 *
 * Usage / 用法: memeloop config
 *
 * Views / 页面：
 * - main: provider list with key status / provider 列表及 key 状态
 * - add_preset: select from known presets / 从预设列表选择
 * - add_manual: manual name + baseUrl + apiKey form / 手动输入表单
 * - edit: edit existing provider / 编辑现有 provider
 * - import_text: paste JSON to import / 粘贴 JSON 导入
 * - export_show: show exportable JSON / 显示可导出的 JSON
 * - delete_confirm: confirm deletion / 确认删除
 */

import { type Key, useApp, useInput } from 'ink';
import fs from 'node:fs';
import React, { useCallback, useEffect, useReducer, useState } from 'react';

import { getAuthPath, setInputSecret } from '../auth/authStore.js';
import { getCloudAccessTokenSecretId, getDefaultConfigPath, loadRawConfig, saveConfig } from '../config.js';
import { DeviceCloudClient, getDefaultDeviceIdentityPath, normalizeDeviceCloudConfiguration } from '../deviceNetwork/index.js';
import { getDataDirectory } from '../runtime/dataDirectory.js';
import { accountFromForm, base64Decode, errorMessage, isRecord, normalizeProviderId, presetAccount } from './configTuiHelpers.js';
import { initialProviderFormState, providerFormReducer } from './configTuiReducer.js';
import type { ConfigTuiState, ConfigView as View } from './configTuiTypes.js';
import {
  AddManualProviderView,
  AddPresetView,
  CloudConnectionView,
  DeleteProviderView,
  EditProviderView,
  ExportProvidersView,
  ImportProvidersView,
  MainProviderListView,
  NodeStatusView,
} from './ConfigTuiViews.js';
import { loadPresets, loadResolvedPresets, type PresetProvider } from './presets.js';
import { addProvider, exportProviders, importProviders, listProviders, type ProviderInfo, removeProvider, updateProvider } from './providerStore.js';

// ─── Main Component / 主组件 ─────────────────────────────────────────

export function ConfigTUI() {
  const { exit } = useApp();

  // State / 状态
  const [view, setView] = useState<View>('main');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState('');
  const [presets, setPresets] = useState<PresetProvider[]>([]);
  const [presetIndex, setPresetIndex] = useState(0);

  // Provider forms share one reducer so add/edit/secret transitions stay pure.
  const [providerForm, dispatchProviderForm] = useReducer(providerFormReducer, initialProviderFormState);
  const { addName, addBaseUrl, addApiKey, addModels, addCatalogProvider, addFieldIndex, editState } = providerForm;

  const setAddValue = useCallback((field: 'addName' | 'addBaseUrl' | 'addApiKey', value: string) => {
    dispatchProviderForm({ type: 'set-add-value', field, value });
  }, []);
  const setEditValue = useCallback((field: 'providerId' | 'baseUrl' | 'apiKey', value: string) => {
    dispatchProviderForm({ type: 'set-edit-value', field, value });
  }, []);

  // Import state
  const [importText, setImportText] = useState('');

  // Export data
  const [exportData, setExportData] = useState('');

  // Node status state
  const [nodeStatus, setNodeStatus] = useState<Record<string, string>>({});

  // Cloud connection state
  const [cloudUrl, setCloudUrl] = useState('');
  const [cloudAccessToken, setCloudAccessToken] = useState('');
  const [cloudFieldIndex, setCloudFieldIndex] = useState(0);
  const [cloudSaving, setCloudSaving] = useState(false);

  // Load state on mount and on view transitions
  const refresh = useCallback(() => {
    setProviders(listProviders());
    setMessage('');
    setSelectedIndex(0);
  }, []);

  const enterAddManual = useCallback(() => {
    dispatchProviderForm({ type: 'reset-add' });
    setView('add_manual');
  }, []);

  const enterAddPreset = useCallback(() => {
    setPresets(loadPresets());
    setPresetIndex(0);
    setView('add_preset');
    void loadResolvedPresets().then((result) => {
      setPresets(result.presets);
      if (result.refreshError) {
        setMessage(`Using ${result.source} model catalog: ${result.refreshError}`);
      }
    });
  }, []);

  const enterEdit = useCallback(
    (index: number) => {
      const p = providers[index];
      if (!p) return;
      dispatchProviderForm({
        type: 'begin-edit',
        state: {
          origProviderId: p.providerId,
          providerId: p.providerId,
          providerType: p.providerType,
          baseUrl: p.baseUrl ?? '',
          apiKey: '',
          fieldIndex: 0,
        },
      });
      setView('edit');
    },
    [providers],
  );

  const enterImport = useCallback(() => {
    setImportText('');
    setView('import_text');
  }, []);

  const enterExport = useCallback(() => {
    setExportData(exportProviders());
    setView('export_show');
  }, []);

  const enterNode = useCallback(() => {
    try {
      const cfg = loadRawConfig();
      const identityPath = getDefaultDeviceIdentityPath();
      let peerId = '(created on first start)';
      if (fs.existsSync(identityPath)) {
        const stored: unknown = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
        if (isRecord(stored) && typeof stored.peerId === 'string') peerId = stored.peerId;
      }
      setNodeStatus({
        name: cfg.name ?? '(not set)',
        peerId,
        cloudUrl: cfg.cloudUrl ?? '(not set)',
        providers: cfg.providers?.map((provider) => provider.providerId).join(', ') ?? '(none)',
        fileBaseDir: cfg.fileBaseDir ?? '(not set)',
        identityPath,
      });
    } catch (error: unknown) {
      setNodeStatus({ error: errorMessage(error) });
    }
    setView('node');
  }, []);

  const enterCloud = useCallback(() => {
    setCloudUrl(loadRawConfig().cloudUrl ?? '');
    setCloudAccessToken('');
    setCloudFieldIndex(0);
    setCloudSaving(false);
    setView('cloud');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ─── Keyboard Handler / 键盘处理 ──────────────────────────────────

  useInput(
    useCallback(
      (_input: string, key: Key) => {
        // Global: Ctrl+C exits
        if (key.ctrl && _input === 'c') {
          exit();
          return;
        }

        switch (view) {
          case 'main':
            handleMainInput(_input, key);
            break;
          case 'add_preset':
            handleAddPresetInput(_input, key);
            break;
          case 'add_manual':
            handleAddManualInput(_input, key);
            break;
          case 'edit':
            handleEditInput(_input, key);
            break;
          case 'import_text':
            handleImportInput(_input, key);
            break;
          case 'export_show':
          case 'delete_confirm':
            handleConfirmInput(_input, key);
            break;
          case 'node':
            handleSimpleInput(_input, key);
            break;
          case 'cloud':
            handleCloudInput(_input, key);
            break;
        }
      },
      [
        view,
        selectedIndex,
        providers,
        presets,
        presetIndex,
        addName,
        addBaseUrl,
        addApiKey,
        addFieldIndex,
        editState,
        importText,
        cloudUrl,
        cloudAccessToken,
        cloudFieldIndex,
        cloudSaving,
      ],
    ),
  );

  // ─── Input Handlers / 输入处理器 ──────────────────────────────────

  function handleMainInput(input: string, key: Key) {
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (key.downArrow) {
      setSelectedIndex((index) => Math.min(providers.length, index + 1)); // +1 for "Add" option
    } else if (input === 'a' || input === 'A') {
      // Add: go to preset selection
      enterAddPreset();
    } else if (input === 'm' || input === 'M') {
      // Manual add
      enterAddManual();
    } else if (input === 'e' || input === 'E') {
      // Edit selected
      if (selectedIndex < providers.length) {
        enterEdit(selectedIndex);
      }
    } else if (input === 'd' || input === 'D') {
      // Delete selected
      if (selectedIndex < providers.length) {
        setView('delete_confirm');
      }
    } else if (input === 'i' || input === 'I') {
      // Import
      enterImport();
    } else if (input === 'x' || input === 'X') {
      // Export
      enterExport();
    } else if (input === 'n' || input === 'N') {
      // Device status
      enterNode();
    } else if (input === 'c' || input === 'C') {
      // Cloud connection
      enterCloud();
    } else if (input === 'q' || input === 'Q' || key.escape) {
      exit();
    } else if (key.return) {
      // Enter: if on "add" row, go to preset; if on provider, edit
      if (selectedIndex >= providers.length) {
        enterAddPreset();
      } else {
        enterEdit(selectedIndex);
      }
    }
  }

  function handleAddPresetInput(input: string, key: Key) {
    if (key.upArrow) {
      setPresetIndex((index) => Math.max(0, index - 1));
    } else if (key.downArrow) {
      setPresetIndex((index) => Math.min(presets.length - 1, index + 1));
    } else if (key.return) {
      // Select preset and go to manual form with values filled
      const preset = presets[presetIndex];
      if (preset) {
        const account = presetAccount(preset);
        dispatchProviderForm({
          type: 'select-preset',
          providerId: account.providerId,
          baseUrl: account.baseUrl ?? '',
          models: account.models,
          ...(account.catalogProvider === undefined ? {} : { catalogProvider: account.catalogProvider }),
        });
        setView('add_manual');
        setMessage(`Selected "${preset.name}". Enter your API key. / 已选择 "${preset.name}"，请输入 API key。`);
      }
    } else if (input === 'm' || input === 'M') {
      enterAddManual();
    } else if (input === 'q' || input === 'Q' || key.escape) {
      setView('main');
      refresh();
    }
  }

  function handleAddManualInput(input: string, key: Key) {
    if (key.escape) {
      setView('main');
      refresh();
      return;
    }
    if (key.tab) {
      dispatchProviderForm({ type: 'set-add-field-index', index: (addFieldIndex + 1) % 3 });
      return;
    }
    if (key.upArrow) {
      dispatchProviderForm({ type: 'set-add-field-index', index: addFieldIndex === 0 ? 2 : addFieldIndex - 1 });
      return;
    }
    if (key.downArrow || key.return) {
      if (addFieldIndex < 2) {
        dispatchProviderForm({ type: 'set-add-field-index', index: addFieldIndex + 1 });
      } else {
        // Submit
        if (!addName.trim()) {
          setMessage('Provider ID is required. / Provider ID 不能为空。');
          return;
        }
        if (!addApiKey.trim()) {
          setMessage('API key is required. / API key 不能为空。');
          return;
        }
        try {
          const account = accountFromForm(addName, addBaseUrl, addModels, addCatalogProvider);
          addProvider(account, addApiKey.trim());
          setMessage(`Provider "${account.providerId}" added. / Provider "${account.providerId}" 已添加。`);
          refresh();
          setView('main');
        } catch (error: unknown) {
          setMessage(`Provider rejected: ${errorMessage(error)} / Provider 配置被拒绝：${errorMessage(error)}`);
        }
      }
      return;
    }
    if (key.backspace || key.delete) {
      // Handle backspace for current field
      if (addFieldIndex === 0) setAddValue('addName', addName.slice(0, -1));
      else if (addFieldIndex === 1) setAddValue('addBaseUrl', addBaseUrl.slice(0, -1));
      else setAddValue('addApiKey', addApiKey.slice(0, -1));
      return;
    }
    // Regular text input
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      if (addFieldIndex === 0) setAddValue('addName', addName + input);
      else if (addFieldIndex === 1) setAddValue('addBaseUrl', addBaseUrl + input);
      else setAddValue('addApiKey', addApiKey + input);
    }
  }

  function handleEditInput(input: string, key: Key) {
    if (!editState) return;
    if (key.escape) {
      setView('main');
      refresh();
      return;
    }
    if (key.tab || key.downArrow) {
      if (editState) dispatchProviderForm({ type: 'set-edit-field-index', index: (editState.fieldIndex + 1) % 3 });
      return;
    }
    if (key.upArrow) {
      if (editState) dispatchProviderForm({ type: 'set-edit-field-index', index: editState.fieldIndex === 0 ? 2 : editState.fieldIndex - 1 });
      return;
    }
    if (key.return && editState.fieldIndex === 2) {
      // Submit edit
      let normalizedProviderId: string;
      try {
        normalizedProviderId = normalizeProviderId(editState.providerId);
      } catch (error: unknown) {
        setMessage(`Provider rejected: ${errorMessage(error)} / Provider 配置被拒绝：${errorMessage(error)}`);
        return;
      }
      if (normalizedProviderId !== editState.origProviderId) {
        setMessage('Provider ID cannot be changed; remove and add a new account.');
        return;
      }
      try {
        updateProvider(editState.origProviderId, {
          providerType: editState.providerType,
          baseUrl: editState.baseUrl,
        }, editState.apiKey || undefined);
      } catch (error: unknown) {
        setMessage(`Provider rejected: ${errorMessage(error)}`);
        return;
      }
      setMessage(`Provider "${normalizedProviderId}" updated. / Provider "${normalizedProviderId}" 已更新。`);
      refresh();
      setView('main');
      return;
    }
    if (key.backspace || key.delete) {
      if (editState) {
        const fields = ['providerId', 'baseUrl', 'apiKey'] as const;
        const field = fields[editState.fieldIndex];
        setEditValue(field, editState[field].slice(0, -1));
      }
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      if (editState) {
        const fields = ['providerId', 'baseUrl', 'apiKey'] as const;
        const field = fields[editState.fieldIndex];
        setEditValue(field, editState[field] + input);
      }
    }
  }

  function handleImportInput(input: string, key: Key) {
    if (key.escape) {
      setView('main');
      refresh();
      return;
    }
    if (key.return) {
      // Try base64 first, then JSON
      let json = importText;
      // Check if importText looks like base64 (no { at start)
      if (!importText.trim().startsWith('{')) {
        json = base64Decode(importText);
      }
      try {
        const result = importProviders(json);
        setMessage(
          `Imported ${result.added} provider(s); missing secrets: ${result.missingSecrets.length}. / 导入了 ${result.added} 个 provider；缺少密钥 ${result.missingSecrets.length} 个。`,
        );
        refresh();
        setView('main');
      } catch (error: unknown) {
        const detail = errorMessage(error);
        setMessage(`Import failed: ${detail} / 导入失败：${detail}`);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setImportText((v) => v.slice(0, -1));
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      setImportText((v) => v + input);
    }
  }

  function handleConfirmInput(input: string, key: Key) {
    if (input === 'y' || input === 'Y') {
      if (view === 'delete_confirm') {
        const p = providers[selectedIndex];
        if (p) {
          removeProvider(p.providerId);
          setMessage(`Deleted "${p.providerId}". / 已删除 "${p.providerId}"。`);
          refresh();
        }
      }
      setView('main');
    } else if (input === 'n' || input === 'N' || key.escape) {
      setView('main');
    }
  }

  function handleSimpleInput(_input: string, key: Key) {
    if (_input === 'q' || _input === 'Q' || key.escape) {
      setView('main');
      refresh();
    }
  }

  function handleCloudInput(input: string, key: Key) {
    if (key.escape) {
      setView('main');
      refresh();
      return;
    }
    if (key.tab || key.downArrow) {
      setCloudFieldIndex((index) => (index + 1) % 2);
      return;
    }
    if (key.upArrow) {
      setCloudFieldIndex((index) => (index === 0 ? 1 : index - 1));
      return;
    }
    if (key.return) {
      if (cloudFieldIndex === 0) {
        setCloudFieldIndex(1);
      } else {
        // Submit cloud credentials
        if (!cloudUrl.trim() || !cloudAccessToken.trim()) {
          setMessage('Cloud URL and access token are required. / Cloud URL 和访问令牌不能为空。');
          return;
        }
        setCloudSaving(true);
        void (async () => {
          try {
            const normalized = normalizeDeviceCloudConfiguration({ baseUrl: cloudUrl, accessToken: cloudAccessToken });
            const client = new DeviceCloudClient(normalized.baseUrl, normalized.accessToken);
            await Promise.all([
              client.getConnectionGrantPublicKey(),
              client.listDevices(),
            ]);
            const cfg = loadRawConfig();
            cfg.cloudUrl = normalized.baseUrl;
            const secretId = getCloudAccessTokenSecretId(normalized.baseUrl);
            // Intentionally persist the literal `${input:<id>}` placeholder;
            // loadConfig resolves it from the 0600 auth store at runtime.
            cfg.cloudAccessToken = '${input:' + secretId + '}';
            saveConfig(cfg);
            setInputSecret(secretId, normalized.accessToken);
            setCloudAccessToken('');
            setMessage('Validated and saved Cloud credentials. / 云凭证已验证并保存。');
          } catch (error: unknown) {
            const detail = errorMessage(error);
            setMessage(`Save failed: ${detail} / 保存失败：${detail}`);
          } finally {
            setCloudSaving(false);
          }
        })();
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (cloudFieldIndex === 0) setCloudUrl((v) => v.slice(0, -1));
      else setCloudAccessToken((v) => v.slice(0, -1));
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      if (cloudFieldIndex === 0) setCloudUrl((v) => v + input);
      else setCloudAccessToken((v) => v + input);
    }
  }

  // Rendering is intentionally delegated to focused view components. Keeping
  // presentation separate from keyboard/state side effects makes each flow
  // independently testable and prevents this coordinator becoming a second
  // provider model or secret store.
  const configPath = getDefaultConfigPath();
  const viewState: ConfigTuiState = {
    view,
    providers,
    selectedIndex,
    message,
    presets,
    presetIndex,
    addName,
    addBaseUrl,
    addApiKey,
    addModels,
    ...(addCatalogProvider === undefined ? {} : { addCatalogProvider }),
    addFieldIndex,
    editState,
    importText,
    exportData,
    nodeStatus,
    cloudUrl,
    cloudAccessToken,
    cloudFieldIndex,
    cloudSaving,
  };

  if (view === 'main') {
    return <MainProviderListView state={viewState} configPath={configPath} authPath={getAuthPath()} dataDirectory={getDataDirectory()} />;
  }
  if (view === 'add_preset') return <AddPresetView state={viewState} />;
  if (view === 'add_manual') return <AddManualProviderView state={viewState} />;
  if (view === 'edit') return <EditProviderView state={viewState} />;
  if (view === 'import_text') return <ImportProvidersView state={viewState} />;
  if (view === 'export_show') return <ExportProvidersView state={viewState} />;
  if (view === 'delete_confirm') return <DeleteProviderView state={viewState} />;
  if (view === 'node') return <NodeStatusView state={viewState} />;
  if (view === 'cloud') return <CloudConnectionView state={viewState} />;
  return <MainProviderListView state={viewState} configPath={configPath} authPath={getAuthPath()} dataDirectory={getDataDirectory()} />;
}

// ─── Launch function / 启动函数 ──────────────────────────────────────

/**
 * Launch the Config TUI. / 启动配置 TUI。
 * Exported for use by cli.ts config command.
 */
export async function launchConfigTUI(): Promise<void> {
  const { render } = await import('ink');

  // render returns an instance with waitUntilExit()
  const instance = render(React.createElement(ConfigTUI));

  // Wait for the user to quit (app.exit()) before resolving
  await instance.waitUntilExit();
}
