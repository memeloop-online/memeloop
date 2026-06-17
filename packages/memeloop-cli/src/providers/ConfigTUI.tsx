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

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method, @typescript-eslint/no-floating-promises, unicorn/prevent-abbreviations */

import { Box, Text, useApp, useInput } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useCallback, useEffect, useState } from 'react';

import { getAuthPath, setApiKey } from '../auth/authStore.js';
import { getDefaultConfigPath } from '../config.js';
import { getDataDir } from '../runtime/dataDir.js';
import { loadPresets, type PresetProvider } from './presets.js';
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

/** Detect Claude Code config at ~/.claude.json. / 检测 ~/.claude.json 的 Claude Code 配置。 */
function detectClaudeCode(): DetectedToolConfig | null {
  const p = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const providers: DetectedToolConfig['providers'] = [];
    // Claude Code stores provider/model config under "lm" key
    const lm = data.lm;
    if (lm) {
      for (const [key, value] of Object.entries(lm)) {
        if (value && typeof value === 'object' && value.provider) {
          providers.push({
            name: key,
            baseUrl: value.baseUrl || value.baseURL,
            apiKey: value.apiKey,
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
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const providers: DetectedToolConfig['providers'] = [];
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && value.key) {
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
  const [diagChecks, setDiagChecks] = useState<Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string }>>([]);
  const [diagRunning, setDiagRunning] = useState(false);

  // Cloud register state
  const [cloudUrl, setCloudUrl] = useState('');
  const [cloudOtp, setCloudOtp] = useState('');
  const [cloudFieldIndex, setCloudFieldIndex] = useState(0);
  const [cloudRegistering, setCloudRegistering] = useState(false);

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
    const { loadConfig } = require('../config.js');
    try {
      const cfg = loadConfig();
      setNodeStatus({
        name: cfg.name ?? '(not set)',
        nodeId: cfg.nodeId ?? '(not registered)',
        cloudUrl: cfg.cloudUrl ?? '(not set)',
        providers: cfg.providers?.map((p: any) => p.name).join(', ') ?? '(none)',
        fileBaseDir: cfg.fileBaseDir ?? '(not set)',
        keypairPath: (() => {
          try {
            const { getDefaultKeypairPath } = require('../auth/keypair.js');
            return getDefaultKeypairPath();
          } catch {
            return '(unknown)';
          }
        })(),
        wsAuth: cfg.auth?.ws?.enabled !== false ? (cfg.auth?.ws?.mode ?? 'lan-pin') : 'disabled',
      });
    } catch (e: any) {
      setNodeStatus({ error: e.message });
    }
    setView('node');
  }, []);

  const enterDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    setDiagChecks([]);
    setView('diagnostics');

    const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string }> = [];
    const { loadConfig: lc } = await import('../config.js');
    const { getAuthPath: gap } = await import('../auth/authStore.js');
    const { getDataDir: gdd } = await import('../runtime/dataDir.js');

    // Config
    try {
      lc();
      checks.push({ name: 'Config file', status: 'ok', message: 'Loaded' });
    } catch (e: any) {
      checks.push({ name: 'Config file', status: 'error', message: e.message });
    }

    // Auth file
    try {
      const ap = gap();
      const { existsSync, statSync } = await import('node:fs');
      if (existsSync(ap)) {
        const mode = statSync(ap).mode.toString(8).slice(-3);
        checks.push({ name: 'Auth file', status: mode === '600' ? 'ok' : 'warn', message: `${ap} (mode ${mode})` });
      } else {
        checks.push({ name: 'Auth file', status: 'warn', message: 'Not found' });
      }
    } catch (e: any) {
      checks.push({ name: 'Auth file', status: 'error', message: e.message });
    }

    // Node.js
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    checks.push({ name: 'Node.js', status: major >= 22 ? 'ok' : 'warn', message: `${process.version}${major < 22 ? ' — recommend >=22' : ''}` });

    // Git
    try {
      const { execSync } = await import('node:child_process');
      const v = execSync('git --version', { encoding: 'utf-8' }).trim();
      checks.push({ name: 'Git', status: 'ok', message: v });
    } catch {
      checks.push({ name: 'Git', status: 'warn', message: 'Not found' });
    }

    // Data dir
    try {
      const dd = gdd();
      const { existsSync, mkdirSync, writeFileSync, unlinkSync } = await import('node:fs');
      const { join } = await import('node:path');
      if (!existsSync(dd)) mkdirSync(dd, { recursive: true });
      const tf = join(dd, `.diag-${Date.now()}`);
      writeFileSync(tf, '');
      unlinkSync(tf);
      checks.push({ name: 'Data directory', status: 'ok', message: dd });
    } catch (e: any) {
      checks.push({ name: 'Data directory', status: 'error', message: e.message });
    }

    // Provider connectivity
    try {
      const cfg = lc();
      if (cfg.providers?.length) {
        for (const p of cfg.providers) {
          try {
            const url = p.baseUrl ?? (p.options?.baseURL as string | undefined);
            if (!url) {
              checks.push({ name: `Provider ${p.name}`, status: 'warn', message: 'No baseUrl' });
              continue;
            }
            const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            const ok = res.ok || res.status === 404 || res.status === 405;
            checks.push({ name: `Provider ${p.name}`, status: ok ? 'ok' : 'warn', message: `${url} (HTTP ${res.status})` });
          } catch (e: any) {
            checks.push({ name: `Provider ${p.name}`, status: 'warn', message: e.message });
          }
        }
      }
    } catch { /* ignore */ }

    setDiagChecks(checks);
    setDiagRunning(false);
  }, []);

  const enterCloud = useCallback(() => {
    setCloudUrl('');
    setCloudOtp('');
    setCloudFieldIndex(0);
    setCloudRegistering(false);
    setView('cloud');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ─── Keyboard Handler / 键盘处理 ──────────────────────────────────

  useInput(
    useCallback(
      (_input: string, key: any) => {
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
        cloudOtp,
        cloudFieldIndex,
        cloudRegistering,
      ],
    ),
  );

  // ─── Input Handlers / 输入处理器 ──────────────────────────────────

  function handleMainInput(input: string, key: any) {
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
      // Node status
      enterNode();
    } else if (input === 'c' || input === 'C') {
      // Cloud register
      enterCloud();
    } else if (input === 'h' || input === 'H') {
      // Diagnostics (Health check)
      enterDiagnostics();
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

  function handleAddPresetInput(input: string, key: any) {
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

  function handleAddManualInput(input: string, key: any) {
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
          addBaseUrl.trim() || undefined as any,
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

  function handleEditInput(input: string, key: any) {
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
        addProvider(editState.name, editState.baseUrl || undefined as any, editState.apiKey || '');
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

  function handleImportInput(input: string, key: any) {
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
      } catch (e: any) {
        setMessage(`Import failed: ${e.message} / 导入失败：${e.message}`);
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

  function handleConfirmInput(input: string, key: any) {
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

  function handleMigrationInput(input: string, key: any) {
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

  function handleSimpleInput(_input: string, key: any) {
    if (_input === 'q' || _input === 'Q' || key.escape) {
      setView('main');
      refresh();
    }
  }

  function handleCloudInput(input: string, key: any) {
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
        if (!cloudUrl.trim() || !cloudOtp.trim()) {
          setMessage('Cloud URL and access token are required. / Cloud URL 和访问令牌不能为空。');
          return;
        }
        setCloudRegistering(true);
        void (async () => {
          try {
            const { loadConfig: lc, saveConfig: sc } = await import('../config.js');
            const cfg = lc();
            cfg.cloudUrl = cloudUrl.trim();
            cfg.cloudAccessToken = cloudOtp.trim();
            sc(cfg);
            setMessage(`Saved cloud credentials. / 已保存云凭证。`);
          } catch (e: any) {
            setMessage(`Save failed: ${e.message} / 保存失败：${e.message}`);
          } finally {
            setCloudRegistering(false);
          }
        })();
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (cloudFieldIndex === 0) setCloudUrl((v) => v.slice(0, -1));
      else setCloudOtp((v) => v.slice(0, -1));
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      if (cloudFieldIndex === 0) setCloudUrl((v) => v + input);
      else setCloudOtp((v) => v + input);
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
            Data: {getDataDir()}
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
          <Text bold>Node Status / 节点状态</Text>
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

  // ─── Cloud View / 云注册页 ─────────────────────────────────────────

  function renderCloud() {
    const fields = ['Cloud URL', 'Access Token'];
    return (
      <Box flexDirection='column' padding={1}>
        <Box marginBottom={1}>
          <Text bold>Cloud Registration / 云端注册</Text>
        </Box>
        {cloudRegistering ? <Text>Registering... / 注册中...</Text> : (
          <>
            {fields.map((label, index) => {
              const value = index === 0 ? cloudUrl : cloudOtp;
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
            <Text color='green'>Tab</Text> switch field{'  '}<Text color='green'>Enter</Text> register{'  '}<Text color='green'>Esc</Text> back
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
