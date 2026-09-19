import { Box, Text } from 'ink';

import { base64Encode, maskKey } from './configTuiHelpers.js';
import type { ConfigTuiState } from './configTuiTypes.js';

export function MainProviderListView({
  state,
  configPath,
  authPath,
  dataDirectory,
}: {
  state: ConfigTuiState;
  configPath: string;
  authPath: string;
  dataDirectory: string;
}) {
  const { providers, selectedIndex, message } = state;
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold underline>MemeLoop Config</Text>
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
        {providers.map((provider, index) => (
          <Box key={provider.providerId}>
            <Text color={index === selectedIndex ? 'cyan' : undefined}>
              {index === selectedIndex ? '▶ ' : '  '}
              {provider.providerId.padEnd(20)}
              {provider.hasApiKey ? <Text color='green'>{provider.apiKeyMasked}</Text> : <Text color='red'>(no key)</Text>}
              {provider.baseUrl ? `  ${provider.baseUrl}` : ''}
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
        <Text dimColor>Config: {configPath}</Text>
        <Text dimColor>Auth: {authPath}</Text>
        <Text dimColor>Data: {dataDirectory}</Text>
      </Box>

      <MessageLine message={message} />

      <Box marginTop={1}>
        <Text dimColor>
          <Text color='green'>A</Text>dd preset{'  '}<Text color='green'>M</Text>anual{'  '}<Text color='green'>E</Text>dit{'  '}<Text color='green'>D</Text>el{'  '}
          <Text color='green'>I</Text>mport{'  '}e<Text color='green'>X</Text>port{'\n'}
          <Text color='green'>N</Text>ode{'  '}<Text color='green'>C</Text>loud{'  '}<Text color='green'>Q</Text>uit
        </Text>
      </Box>
    </Box>
  );
}

export function AddPresetView({ state }: { state: ConfigTuiState }) {
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Add Provider — Select a preset / 选择预设</Text>
      </Box>
      {state.presets.map((preset, index) => (
        <Box key={preset.providerId}>
          <Text color={index === state.presetIndex ? 'cyan' : undefined}>
            {index === state.presetIndex ? '▶ ' : '  '}
            {preset.name.padEnd(20)}
            <Text dimColor>{preset.description}</Text>
          </Text>
        </Box>
      ))}
      <MessageLine message={state.message} />
      <Box marginTop={1}>
        <Text dimColor>
          <Text color='green'>Enter</Text> select{'  '}<Text color='green'>M</Text> manual entry{'  '}<Text color='green'>Esc</Text> back
        </Text>
      </Box>
    </Box>
  );
}

export function AddManualProviderView({ state }: { state: ConfigTuiState }) {
  const fields = ['Name', 'Base URL', 'API Key'];
  const values = [state.addName, state.addBaseUrl, state.addApiKey];
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Add Provider — Manual / 手动添加</Text>
      </Box>
      {fields.map((label, index) => {
        const value = values[index] ?? '';
        const displayValue = index === 2 && value ? maskKey(value) : value;
        return (
          <Box key={label}>
            <Text color={index === state.addFieldIndex ? 'green' : undefined}>
              {index === state.addFieldIndex ? '▶ ' : '  '}
              {label.padEnd(12)}: {displayValue}
              {index === state.addFieldIndex ? <Text color='cyan'>█</Text> : null}
            </Text>
          </Box>
        );
      })}
      <MessageLine message={state.message} />
      <Box marginTop={1}>
        <Text dimColor>
          <Text color='green'>Tab/↓↑</Text> switch field{'  '}<Text color='green'>Enter</Text> submit{'  '}<Text color='green'>Esc</Text> back
        </Text>
      </Box>
    </Box>
  );
}

export function EditProviderView({ state }: { state: ConfigTuiState }) {
  const editState = state.editState;
  if (!editState) return null;
  const fields = ['Provider ID', 'Base URL', 'API Key (leave blank to keep)'];
  const values = [editState.providerId, editState.baseUrl, editState.apiKey];
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Edit Provider / 编辑 Provider</Text>
      </Box>
      {fields.map((label, index) => {
        const value = values[index] ?? '';
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
      <MessageLine message={state.message} />
      <Box marginTop={1}>
        <Text dimColor>
          <Text color='green'>Tab/↓↑</Text> switch field{'  '}<Text color='green'>Enter</Text> save{'  '}<Text color='green'>Esc</Text> back
        </Text>
      </Box>
    </Box>
  );
}

export function ImportProvidersView({ state }: { state: ConfigTuiState }) {
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Import Providers / 导入 Provider</Text>
      </Box>
      <Text dimColor>Paste JSON or Base64 (e.g. from export):</Text>
      <Box marginTop={1}>
        <Text>
          {state.importText || <Text color='gray'>(start typing... / 开始输入...)</Text>}
          <Text color='cyan'>█</Text>
        </Text>
      </Box>
      <MessageLine message={state.message} />
      <Box marginTop={1}>
        <Text dimColor>
          <Text color='green'>Enter</Text> submit{'  '}<Text color='green'>Esc</Text> back
        </Text>
      </Box>
    </Box>
  );
}

export function ExportProvidersView({ state }: { state: ConfigTuiState }) {
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Export Providers / 导出 Provider</Text>
      </Box>
      <Text dimColor>Copy the Base64 below and use "Import" on another node. / 复制下面的 Base64，在另一节点使用 "Import" 导入。</Text>
      <Box marginTop={1} flexDirection='column'>
        <Text>{base64Encode(state.exportData)}</Text>
      </Box>
      <MessageLine message={state.message} />
      <Box marginTop={1}>
        <Text dimColor>
          Press <Text color='green'>Enter</Text> to go back / 回车返回
        </Text>
      </Box>
    </Box>
  );
}

export function DeleteProviderView({ state }: { state: ConfigTuiState }) {
  const provider = state.providers[state.selectedIndex];
  return (
    <Box flexDirection='column' padding={1} borderStyle='round' borderColor='red'>
      <Text bold color='red'>Delete Provider? / 确认删除？</Text>
      <Text>Provider ID: {provider?.providerId ?? '(none)'}</Text>
      <Box marginTop={1}>
        <Text>
          <Text color='green'>Y</Text> confirm / 确认{'  '}<Text color='red'>N</Text> cancel / 取消
        </Text>
      </Box>
    </Box>
  );
}

export function NodeStatusView({ state }: { state: ConfigTuiState }) {
  const entries = Object.entries(state.nodeStatus);
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Device Status / 设备状态</Text>
      </Box>
      {entries.length === 0 ? <Text dimColor>Loading...</Text> : entries.map(([key, value]) => (
        <Box key={key}>
          <Text>{key.padEnd(14)}:</Text>
          <Text color={value.startsWith('(not') ? 'yellow' : undefined}>{value}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          Press <Text color='green'>Esc</Text> to go back / 返回
        </Text>
      </Box>
    </Box>
  );
}

export function CloudConnectionView({ state }: { state: ConfigTuiState }) {
  const fields = ['Cloud URL', 'Access Token'];
  const values = [state.cloudUrl, state.cloudAccessToken];
  return (
    <Box flexDirection='column' padding={1}>
      <Box marginBottom={1}>
        <Text bold>Cloud Connection / 云端连接</Text>
      </Box>
      {state.cloudSaving ? <Text>Validating and saving... / 正在验证并保存...</Text> : (
        fields.map((label, index) => {
          const value = values[index] ?? '';
          const displayValue = index === 1 ? '*'.repeat(value.length) : value;
          return (
            <Box key={label}>
              <Text color={index === state.cloudFieldIndex ? 'green' : undefined}>
                {index === state.cloudFieldIndex ? '▶ ' : '  '}
                {label.padEnd(14)}: {displayValue}
                {index === state.cloudFieldIndex ? <Text color='cyan'>█</Text> : null}
              </Text>
            </Box>
          );
        })
      )}
      <MessageLine message={state.message} />
      <Box marginTop={1}>
        <Text dimColor>
          <Text color='green'>Tab</Text> switch field{'  '}<Text color='green'>Enter</Text> validate and save{'  '}<Text color='green'>Esc</Text> back
        </Text>
      </Box>
    </Box>
  );
}

function MessageLine({ message }: { message: string }) {
  if (!message) return null;
  return (
    <Box marginTop={1}>
      <Text color='yellow'>{message}</Text>
    </Box>
  );
}
