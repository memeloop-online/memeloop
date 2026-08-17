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
 * - migration: import from Claude Code / OpenCode / 从其他工具迁移
 */

import { Box, type Key, Text, useApp, useInput } from 'ink';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useCallback, useEffect, useState } from 'react';

import { getAuthPath, setApiKey, setInputSecret } from '../auth/authStore.js';
import { getCloudAccessTokenSecretId, getDefaultConfigPath, loadConfig, loadRawConfig, saveConfig } from '../config.js';
import { DeviceCloudClient, getDefaultDeviceIdentityPath, normalizeDeviceCloudConfiguration } from '../deviceNetwork/index.js';
import { getDataDirectory } from '../runtime/dataDirectory.js';
import { loadPresets, loadResolvedPresets, type PresetProvider } from './presets.js';
import { addProvider, exportProviders, importProviders, listProviders, type ProviderInfo, removeProvider, updateProvider } from './providerStore.js';

// ─── Types / 类型 ────────────────────────────────────────────────────

type View =
  | 'main'
  | 'add_preset'
  | 'add_manual'
  | 'edit'
  | 'import_text'
  | 'export_show'
  | 'delete_confirm'
  | 'migration'
  | 'node'
  | 'diagnostics'
  | 'cloud';

interface EditState {
  origName: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  fieldIndex: number; // 0=name, 1=baseUrl, 2=apiKey
}

interface DetectedToolConfig {
  tool: string;
  configPath: string;
  providers: Array<{ name: string; baseUrl?: string; apiKey?: string }>;
}

interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

// ─── Helpers / 辅助函数 ──────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + '***';
  return key.slice(0, 6) + '***' + key.slice(-4);
}

function base64Encode(string_: string): string {
  return Buffer.from(string_).toString('base64');
}

function base64Decode(string_: string): string {
  return Buffer.from(string_, 'base64').toString('utf-8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collect diagnostics independently from Ink state/rendering. */
export async function collectDiagnostics(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  try {
    loadConfig();
    checks.push({ name: 'Config file', status: 'ok', message: 'Loaded' });
  } catch (error: unknown) {
    checks.push({ name: 'Config file', status: 'error', message: errorMessage(error) });
  }

  try {
    const authPath = getAuthPath();
    if (fs.existsSync(authPath)) {
      const mode = fs.statSync(authPath).mode.toString(8).slice(-3);
      checks.push({ name: 'Auth file', status: mode === '600' ? 'ok' : 'warn', message: `${authPath} (mode ${mode})` });
    } else {
      checks.push({ name: 'Auth file', status: 'warn', message: 'Not found' });
    }
  } catch (error: unknown) {
    checks.push({ name: 'Auth file', status: 'error', message: errorMessage(error) });
  }

  const major = Number.parseInt(process.version.slice(1).split('.')[0] ?? '', 10);
  checks.push({ name: 'Node.js', status: major >= 24 ? 'ok' : 'warn', message: `${process.version}${major < 24 ? ' — requires >=24' : ''}` });

  try {
    const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
    checks.push({ name: 'Git', status: 'ok', message: version });
  } catch {
    checks.push({ name: 'Git', status: 'warn', message: 'Not found' });
  }

  try {
    const dataDirectory = getDataDirectory();
    if (!fs.existsSync(dataDirectory)) fs.mkdirSync(dataDirectory, { recursive: true });
    const testFile = path.join(dataDirectory, `.diag-${Date.now()}`);
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
    checks.push({ name: 'Data directory', status: 'ok', message: dataDirectory });
  } catch (error: unknown) {
    checks.push({ name: 'Data directory', status: 'error', message: errorMessage(error) });
  }

  try {
    const config = loadConfig();
    for (const provider of config.providers ?? []) {
      const url = provider.baseUrl ?? (provider.options?.baseURL as string | undefined);
      if (!url) {
        checks.push({ name: `Provider ${provider.name}`, status: 'warn', message: 'No baseUrl' });
        continue;
      }
      try {
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        const reachable = response.ok || response.status === 404 || response.status === 405;
        checks.push({ name: `Provider ${provider.name}`, status: reachable ? 'ok' : 'warn', message: `${url} (HTTP ${response.status})` });
      } catch (error: unknown) {
        checks.push({ name: `Provider ${provider.name}`, status: 'warn', message: errorMessage(error) });
      }
    }
  } catch {
    // The config-file diagnostic above already reports configuration errors.
  }

  return checks;
}

/** Detect Claude Code config at ~/.claude.json. / 检测 ~/.claude.json 的 Claude Code 配置。 */
function detectClaudeCode(): DetectedToolConfig | null {
  const p = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const providers: DetectedToolConfig['providers'] = [];
    // Claude Code stores provider/model config under "lm" key
    const lm = isRecord(data) ? data.lm : undefined;
    if (isRecord(lm)) {
      for (const [key, value] of Object.entries(lm)) {
        if (isRecord(value) && value.provider) {
          providers.push({
            name: key,
            ...(typeof value.baseUrl === 'string'
              ? { baseUrl: value.baseUrl }
              : typeof value.baseURL === 'string'
              ? { baseUrl: value.baseURL }
              : {}),
            ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
          });
        }
      }
    }
    return providers.length > 0 ? { tool: 'Claude Code', configPath: p, providers } : null;
  } catch {
    return null;
  }
}

/** Detect OpenCode config at ~/.local/share/opencode/auth.json. / 检测 OpenCode 配置。 */
function detectOpenCode(): DetectedToolConfig | null {
  const p = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const providers: DetectedToolConfig['providers'] = [];
    if (isRecord(data)) {
      for (const [key, value] of Object.entries(data)) {
        if (isRecord(value) && typeof value.key === 'string') {
          providers.push({ name: key, apiKey: value.key });
        }
      }
    }
    return providers.length > 0 ? { tool: 'OpenCode', configPath: p, providers } : null;
  } catch {
    return null;
  }
}

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

  // Add manual / import state
  const [addName, setAddName] = useState('');
  const [addBaseUrl, setAddBaseUrl] = useState('');
  const [addApiKey, setAddApiKey] = useState('');
  const [addFieldIndex, setAddFieldIndex] = useState(0); // 0=name, 1=baseUrl, 2=apiKey

  // Edit state
  const [editState, setEditState] = useState<EditState | null>(null);

  // Import state
  const [importText, setImportText] = useState('');

  // Migration state
  const [detectedTools, setDetectedTools] = useState<DetectedToolConfig[]>([]);
  const [migrationSelected, setMigrationSelected] = useState(new Set());

  // Export data
  const [exportData, setExportData] = useState('');

  // Node status state
  const [nodeStatus, setNodeStatus] = useState<Record<string, string>>({});

  // Diagnostics state
  const [diagChecks, setDiagChecks] = useState<DiagnosticCheck[]>([]);
  const [diagRunning, setDiagRunning] = useState(false);

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
    setAddName('');
    setAddBaseUrl('');
    setAddApiKey('');
    setAddFieldIndex(0);
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
      setEditState({
        origName: p.name,
        name: p.name,
        baseUrl: p.baseUrl ?? '',
        apiKey: '',
        fieldIndex: 0,
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
    setExportData(exportProviders(false));
    setView('export_show');
  }, []);

  const enterMigration = useCallback(() => {
    const tools: DetectedToolConfig[] = [];
    const cc = detectClaudeCode();
    const oc = detectOpenCode();
    if (cc) tools.push(cc);
    if (oc) tools.push(oc);
    setDetectedTools(tools);
    if (tools.length === 0) {
      setMessage('No Claude Code or OpenCode configs found. / 未找到 Claude Code 或 OpenCode 配置。');
      setView('main');
      return;
    }
    setMigrationSelected(new Set());
    setView('migration');
  }, []);

  const enterNode = useCallback(() => {
    try {
      const cfg = loadRawConfig();
      const identityPath = getDefaultDeviceIdentityPath();
      let peerId = '(created on first start)';
      if (fs.existsSync(identityPath)) {
        const stored = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as { peerId?: unknown };
        if (typeof stored.peerId === 'string') peerId = stored.peerId;
      }
      setNodeStatus({
        name: cfg.name ?? '(not set)',
        peerId,
        cloudUrl: cfg.cloudUrl ?? '(not set)',
        providers: cfg.providers?.map((provider) => provider.name).join(', ') ?? '(none)',
        fileBaseDir: cfg.fileBaseDir ?? '(not set)',
        identityPath,
      });
    } catch (error: unknown) {
      setNodeStatus({ error: errorMessage(error) });
    }
    setView('node');
  }, []);

  const enterDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    setDiagChecks([]);
    setView('diagnostics');

    setDiagChecks(await collectDiagnostics());
    setDiagRunning(false);
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
          case 'migration':
            handleMigrationInput(_input, key);
            break;
          case 'node':
          case 'diagnostics':
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
        detectedTools,
        migrationSelected,
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
    } else if (input === 'g' || input === 'G') {
      // Migration
      enterMigration();
    } else if (input === 'n' || input === 'N') {
      // Device status
      enterNode();
    } else if (input === 'c' || input === 'C') {
      // Cloud connection
      enterCloud();
    } else if (input === 'h' || input === 'H') {
      // Diagnostics (Health check)
      void enterDiagnostics();
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
        setAddName(preset.name);
        setAddBaseUrl(preset.baseUrl);
        setAddApiKey('');
        setAddFieldIndex(2); // Jump to API key field
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
      setAddFieldIndex((index) => (index + 1) % 3);
      return;
    }
    if (key.upArrow) {
      setAddFieldIndex((index) => (index === 0 ? 2 : index - 1));
      return;
    }
    if (key.downArrow || key.return) {
      if (addFieldIndex < 2) {
        setAddFieldIndex((index) => index + 1);
      } else {
        // Submit
        if (!addName.trim()) {
          setMessage('Provider name is required. / Provider 名称不能为空。');
          return;
        }
        if (!addApiKey.trim()) {
          setMessage('API key is required. / API key 不能为空。');
          return;
        }
        addProvider(
          addName.trim(),
          addBaseUrl.trim(),
          addApiKey.trim(),
        );
        setMessage(`Provider "${addName.trim()}" added. / Provider "${addName.trim()}" 已添加。`);
        refresh();
        setView('main');
      }
      return;
    }
    if (key.backspace || key.delete) {
      // Handle backspace for current field
      if (addFieldIndex === 0) setAddName((v) => v.slice(0, -1));
      else if (addFieldIndex === 1) setAddBaseUrl((v) => v.slice(0, -1));
      else setAddApiKey((v) => v.slice(0, -1));
      return;
    }
    // Regular text input
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      if (addFieldIndex === 0) setAddName((v) => v + input);
      else if (addFieldIndex === 1) setAddBaseUrl((v) => v + input);
      else setAddApiKey((v) => v + input);
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
      setEditState((s) => s && { ...s, fieldIndex: ((s.fieldIndex + 1) % 3) });
      return;
    }
    if (key.upArrow) {
      setEditState((s) => s && { ...s, fieldIndex: (s.fieldIndex === 0 ? 2 : s.fieldIndex - 1) });
      return;
    }
    if (key.return && editState.fieldIndex === 2) {
      // Submit edit
      if (!editState.name.trim()) {
        setMessage('Name is required.');
        return;
      }
      // If name changed, remove old and add new
      if (editState.name !== editState.origName) {
        removeProvider(editState.origName);
        addProvider(editState.name, editState.baseUrl, editState.apiKey || '');
      } else {
        updateProvider(editState.origName, {
          name: editState.name,
          baseUrl: editState.baseUrl,
        });
        if (editState.apiKey) {
          setApiKey(editState.name, editState.apiKey);
        }
      }
      setMessage(`Provider "${editState.name}" updated. / Provider "${editState.name}" 已更新。`);
      refresh();
      setView('main');
      return;
    }
    if (key.backspace || key.delete) {
      setEditState((s) => {
        if (!s) return s;
        const fields = ['name', 'baseUrl', 'apiKey'] as const;
        const field = fields[s.fieldIndex];
        return { ...s, [field]: (s[field]).slice(0, -1) };
      });
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      setEditState((s) => {
        if (!s) return s;
        const fields = ['name', 'baseUrl', 'apiKey'] as const;
        const field = fields[s.fieldIndex];
        return { ...s, [field]: (s[field]) + input };
      });
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
        try {
          json = base64Decode(importText);
        } catch {
          // Not base64, try as JSON
        }
      }
      try {
        const result = importProviders(json);
        setMessage(`Imported ${result.added} provider(s), skipped ${result.skipped}. / 导入了 ${result.added} 个 provider，跳过 ${result.skipped} 个。`);
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
          removeProvider(p.name);
          setMessage(`Deleted "${p.name}". / 已删除 "${p.name}"。`);
          refresh();
        }
      }
      setView('main');
    } else if (input === 'n' || input === 'N' || key.escape) {
      setView('main');
    }
  }

  function handleMigrationInput(input: string, key: Key) {
    if (key.escape) {
      setView('main');
      refresh();
      return;
    }
    if (input === 'a' || input === 'A') {
      // Select all
      const all = new Set<string>();
      for (const tool of detectedTools) {
        for (const p of tool.providers) all.add(p.name);
      }
      setMigrationSelected(all);
    } else if (input === 's' || input === 'S') {
      // Import selected
      let added = 0;
      for (const tool of detectedTools) {
        for (const p of tool.providers) {
          if (migrationSelected.has(p.name)) {
            try {
              addProvider(p.name, p.baseUrl ?? '', p.apiKey ?? '');
              added++;
            } catch { /* skip */ }
          }
        }
      }
      setMessage(`Migrated ${added} provider(s). / 迁移了 ${added} 个 provider。`);
      refresh();
      setView('main');
    } else if (input === 'q' || input === 'Q') {
      setView('main');
    } else if (key.return) {
      // Toggle selection (simplified: select all detected)
      if (migrationSelected.size > 0) {
        setMigrationSelected(new Set());
      } else {
        const all = new Set<string>();
        for (const tool of detectedTools) {
          for (const p of tool.providers) all.add(p.name);
        }
        setMigrationSelected(all);
      }
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
            cfg.cloudAccessToken = `\${input:${secretId}}`;
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

  // ─── Render / 渲染 ─────────────────────────────────────────────────

  if (view === 'main') return renderMain();
  if (view === 'add_preset') return renderAddPreset();
  if (view === 'add_manual') return renderAddManual();
  if (view === 'edit') return renderEdit();
  if (view === 'import_text') return renderImport();
  if (view === 'export_show') return renderExport();
  if (view === 'delete_confirm') return renderDeleteConfirm();
  if (view === 'migration') return renderMigration();
  if (view === 'node') return renderNode();
  if (view === 'diagnostics') return renderDiagnostics();
  if (view === 'cloud') return renderCloud();
  return renderMain();

  // ─── Main View / 主页面 ────────────────────────────────────────────

  function renderMain() {
    const configPath = (() => {
      try {
        return getDefaultConfigPath();
      } catch {
        return 'memeloop-cli.yaml';
      }
    })();

    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold underline>
            MemeLoop Config
          </Text>
        </Box>

        <Box flexDirection='column' marginBottom={1}>
          <Text bold>Providers:</Text>
          {providers.length === 0 && (
            <Text dimColor>
              {'  (none) — Press '}
              <Text color='green'>A</Text>
              {' to add from presets, '}
              <Text color='green'>M</Text>
              {' for manual'}
            </Text>
          )}
          {providers.map((p, index) => (
            <Box key={p.name}>
              <Text color={index === selectedIndex ? 'cyan' : undefined}>
                {index === selectedIndex ? '▶ ' : '  '}
                {p.name.padEnd(20)}
                {p.hasApiKey ? <Text color='green'>{p.apiKeyMasked}</Text> : <Text color='red'>(no key)</Text>}
                {p.baseUrl ? `  ${p.baseUrl}` : ''}
              </Text>
            </Box>
          ))}
          <Box>
            <Text color={selectedIndex === providers.length ? 'cyan' : undefined}>
              {selectedIndex === providers.length ? '▶ ' : '  '}
              <Text dimColor>+ Add Provider...</Text>
            </Text>
          </Box>
        </Box>

        <Box flexDirection='column' marginTop={1}>
          <Text dimColor>
            Config: {configPath}
          </Text>
          <Text dimColor>
            Auth: {getAuthPath()}
          </Text>
          <Text dimColor>
            Data: {getDataDirectory()}
          </Text>
        </Box>

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>A</Text>dd preset{'  '}<Text color='green'>M</Text>anual{'  '}<Text color='green'>E</Text>dit{'  '}<Text color='green'>D</Text>el{'  '}
            <Text color='green'>I</Text>mport{'  '}e<Text color='green'>X</Text>port{'  '}mi<Text color='green'>G</Text>rate{'\n'}
            <Text color='green'>N</Text>ode{'  '}<Text color='green'>H</Text>ealth{'  '}<Text color='green'>C</Text>loud{'  '}<Text color='green'>Q</Text>uit
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Add Preset View / 预设选择页 ─────────────────────────────────

  function renderAddPreset() {
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Add Provider — Select a preset / 选择预设</Text>
        </Box>

        {presets.map((p, index) => (
          <Box key={p.name}>
            <Text color={index === presetIndex ? 'cyan' : undefined}>
              {index === presetIndex ? '▶ ' : '  '}
              {p.name.padEnd(20)}
              <Text dimColor>{p.description}</Text>
            </Text>
          </Box>
        ))}

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>Enter</Text> select{'  '}<Text color='green'>M</Text> manual entry{'  '}<Text color='green'>Esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Add Manual View / 手动输入页 ─────────────────────────────────

  function renderAddManual() {
    const fields = ['Name', 'Base URL', 'API Key'];
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Add Provider — Manual / 手动添加</Text>
        </Box>

        {fields.map((label, index) => {
          const value = index === 0 ? addName : index === 1 ? addBaseUrl : index === 2 ? addApiKey : '';
          const displayValue = index === 2 && value ? maskKey(value) : value;
          return (
            <Box key={label}>
              <Text color={index === addFieldIndex ? 'green' : undefined}>
                {index === addFieldIndex ? '▶ ' : '  '}
                {label.padEnd(12)}: {displayValue}
                {index === addFieldIndex ? <Text color='cyan'>█</Text> : null}
              </Text>
            </Box>
          );
        })}

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>Tab/↓↑</Text> switch field{'  '}<Text color='green'>Enter</Text> submit{'  '}<Text color='green'>Esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Edit View / 编辑页 ───────────────────────────────────────────

  function renderEdit() {
    if (!editState) return null;
    const fields = ['Name', 'Base URL', 'API Key (leave blank to keep)'];
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Edit Provider / 编辑 Provider</Text>
        </Box>

        {fields.map((label, index) => {
          const value = index === 0 ? editState.name : index === 1 ? editState.baseUrl : index === 2 ? editState.apiKey : '';
          const displayValue = index === 2 && value ? maskKey(value) : value;
          return (
            <Box key={label}>
              <Text color={index === editState.fieldIndex ? 'green' : undefined}>
                {index === editState.fieldIndex ? '▶ ' : '  '}
                {label.padEnd(25)}: {displayValue}
                {index === editState.fieldIndex ? <Text color='cyan'>█</Text> : null}
              </Text>
            </Box>
          );
        })}

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>Tab/↓↑</Text> switch field{'  '}<Text color='green'>Enter</Text> save{'  '}<Text color='green'>Esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Import View / 导入页 ──────────────────────────────────────────

  function renderImport() {
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Import Providers / 导入 Provider</Text>
        </Box>
        <Text dimColor>Paste JSON or Base64 (e.g. from export):</Text>
        <Box marginTop={1}>
          <Text>
            {importText || <Text color='gray'>(start typing... / 开始输入...)</Text>}
            <Text color='cyan'>█</Text>
          </Text>
        </Box>

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>Enter</Text> submit{'  '}<Text color='green'>Esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Export View / 导出页 ──────────────────────────────────────────

  function renderExport() {
    const b64 = base64Encode(exportData);
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Export Providers / 导出 Provider</Text>
        </Box>
        <Text dimColor>
          Copy the Base64 below and use "Import" on another node. / 复制下面的 Base64，在另一节点使用 "Import" 导入。
        </Text>
        <Box marginTop={1} flexDirection='column'>
          <Text>{b64}</Text>
        </Box>

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            Press <Text color='green'>Enter</Text> to go back / 回车返回
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Delete Confirm View / 删除确认页 ──────────────────────────────

  function renderDeleteConfirm() {
    const p = providers[selectedIndex];
    return (
      <Box flexDirection='column' padding={1} borderStyle='round' borderColor='red'>
        <Text bold color='red'>
          Delete Provider? / 确认删除？
        </Text>
        <Text>Name: {p?.name ?? '(none)'}</Text>
        <Box marginTop={1}>
          <Text>
            <Text color='green'>Y</Text> confirm / 确认{'  '}<Text color='red'>N</Text> cancel / 取消
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Migration View / 迁移页 ───────────────────────────────────────

  function renderMigration() {
    const allProviders: Array<{ tool: string; name: string; baseUrl?: string }> = [];
    for (const tool of detectedTools) {
      for (const p of tool.providers) {
        allProviders.push({ tool: tool.tool, name: p.name, baseUrl: p.baseUrl });
      }
    }

    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Migrate from other tools / 从其他工具迁移</Text>
        </Box>

        {detectedTools.map((tool) => (
          <Box key={tool.tool} flexDirection='column' marginBottom={1}>
            <Text bold>
              {tool.tool}: <Text dimColor>{tool.configPath}</Text>
            </Text>
            {tool.providers.map((p) => (
              <Box key={p.name}>
                <Text>
                  {'  '}
                  {migrationSelected.has(p.name) ? <Text color='green'>✓</Text> : <Text color='gray'>○</Text>} {p.name}
                  {p.baseUrl ? ` (${p.baseUrl})` : ''}
                </Text>
              </Box>
            ))}
          </Box>
        ))}

        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}

        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>Enter</Text> toggle select{'  '}<Text color='green'>A</Text> select all{'  '}<Text color='green'>S</Text> import selected{'  '}
            <Text color='green'>Esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Node View / 节点状态页 ────────────────────────────────────────

  function renderNode() {
    const entries = Object.entries(nodeStatus);
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Device Status / 设备状态</Text>
        </Box>
        {entries.length === 0 ? <Text dimColor>Loading...</Text> : (
          entries.map(([k, v]) => (
            <Box key={k}>
              <Text>{k.padEnd(14)}:</Text>
              <Text color={v.startsWith('(not') ? 'yellow' : undefined}>{v}</Text>
            </Box>
          ))
        )}
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text color='green'>Esc</Text> to go back / 返回
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Diagnostics View / 诊断页 ─────────────────────────────────────

  function renderDiagnostics() {
    const okCount = diagChecks.filter((c) => c.status === 'ok').length;
    const warnCount = diagChecks.filter((c) => c.status === 'warn').length;
    const errorCount = diagChecks.filter((c) => c.status === 'error').length;

    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Diagnostics / 诊断</Text>
        </Box>
        {diagRunning ? <Text>Running checks... / 运行检查中...</Text> : (
          <>
            {diagChecks.map((c, index) => {
              const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
              return (
                <Box key={index}>
                  <Text>{icon} {c.name}: {c.message}</Text>
                </Box>
              );
            })}
            <Box marginTop={1}>
              <Text>
                {okCount} OK, {warnCount} warnings, {errorCount} errors
              </Text>
            </Box>
          </>
        )}
        <Box marginTop={1}>
          <Text dimColor>
            Press <Text color='green'>Esc</Text> to go back / 返回
          </Text>
        </Box>
      </Box>
    );
  }

  // ─── Cloud View / 云连接页 ─────────────────────────────────────────

  function renderCloud() {
    const fields = ['Cloud URL', 'Access Token'];
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Cloud Connection / 云端连接</Text>
        </Box>
        {cloudSaving ? <Text>Validating and saving... / 正在验证并保存...</Text> : (
          <>
            {fields.map((label, index) => {
              const value = index === 0 ? cloudUrl : cloudAccessToken;
              const displayValue = index === 1 ? '*'.repeat(value.length) || '' : value;
              return (
                <Box key={label}>
                  <Text color={index === cloudFieldIndex ? 'green' : undefined}>
                    {index === cloudFieldIndex ? '▶ ' : '  '}
                    {label.padEnd(14)}: {displayValue}
                    {index === cloudFieldIndex ? <Text color='cyan'>█</Text> : null}
                  </Text>
                </Box>
              );
            })}
          </>
        )}
        {message
          ? (
            <Box marginTop={1}>
              <Text color='yellow'>{message}</Text>
            </Box>
          )
          : null}
        <Box marginTop={1}>
          <Text dimColor>
            <Text color='green'>Tab</Text> switch field{'  '}<Text color='green'>Enter</Text> validate and save{'  '}<Text color='green'>Esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }
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
