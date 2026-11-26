import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import BugReportIcon from '@mui/icons-material/BugReport';
import SettingsIcon from '@mui/icons-material/Settings';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TuneIcon from '@mui/icons-material/Tune';
import { Box, Button, Chip, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import type { Meta, StoryObj } from '@storybook/react';
import { type ChatMessage, type ConversationMessageListProjection, projectConversationMessageForList } from 'memeloop';
import React, { useState } from 'react';

import type { WebMemeLoopChatAdapter } from '../chat/types.js';
import { AgentChatView } from './AgentChatView.js';

const meta: Meta<typeof AgentChatView> = {
  title: 'Agent/AgentChatView',
  component: AgentChatView,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;

type Story = StoryObj<typeof AgentChatView>;

function createMockAdapter(overrides?: Partial<WebMemeLoopChatAdapter>): WebMemeLoopChatAdapter {
  return {
    conversationId: 'storybook-demo',
    messages: [],
    isRunning: false,
    isLoading: false,
    error: null,
    sendMessage: async () => {},
    cancel: async () => {},
    deleteTurn: async () => {},
    retryTurn: async () => {},
    ...overrides,
  };
}

function createCanonicalMessage(role: ChatMessage['role'], content: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    turnId: `turn-${Math.random().toString(36).slice(2)}`,
    conversationId: 'storybook-demo',
    originNodeId: 'local',
    originSequence: Date.now(),
    timestamp: Date.now(),
    lamportClock: 0,
    role,
    parts: [{ type: 'text', text: content }],
    content,
    ...overrides,
  };
}

function createMessage(
  role: ChatMessage['role'],
  content: string,
  overrides?: Partial<ChatMessage>,
): ConversationMessageListProjection {
  return projectConversationMessageForList(createCanonicalMessage(role, content, overrides), 256 * 1024);
}

function AgentSwitcher() {
  const [anchorElement, setAnchorElement] = useState<null | HTMLElement>(null);
  const [agent, setAgent] = useState('general');
  const agents = [
    { id: 'general', label: '通用助手' },
    { id: 'coder', label: '代码助手' },
    { id: 'writer', label: '写作助手' },
  ];

  return (
    <>
      <Button
        size='small'
        startIcon={<SmartToyIcon />}
        endIcon={<ArrowDropDownIcon />}
        onClick={(event) => {
          setAnchorElement(event.currentTarget);
        }}
        sx={{ textTransform: 'none' }}
      >
        {agents.find((item) => item.id === agent)?.label}
      </Button>
      <Menu
        anchorEl={anchorElement}
        open={Boolean(anchorElement)}
        onClose={() => {
          setAnchorElement(null);
        }}
      >
        {agents.map((item) => (
          <MenuItem
            key={item.id}
            selected={item.id === agent}
            onClick={() => {
              setAgent(item.id);
              setAnchorElement(null);
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function ModelSelector() {
  const [anchorElement, setAnchorElement] = useState<null | HTMLElement>(null);
  const [model, setModel] = useState('OpenAI · gpt-4o');
  const models = ['OpenAI · gpt-4o', 'Anthropic · claude-3-5-sonnet', 'DeepSeek · deepseek-chat'];

  return (
    <>
      <Button
        size='small'
        endIcon={<ArrowDropDownIcon />}
        onClick={(event) => {
          setAnchorElement(event.currentTarget);
        }}
        sx={{ textTransform: 'none' }}
      >
        {model}
      </Button>
      <Menu
        anchorEl={anchorElement}
        open={Boolean(anchorElement)}
        onClose={() => {
          setAnchorElement(null);
        }}
      >
        {models.map((item) => (
          <MenuItem
            key={item}
            selected={item === model}
            onClick={() => {
              setModel(item);
              setAnchorElement(null);
            }}
          >
            {item}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

function InlineToolbar() {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, overflow: 'hidden' }}>
        <AgentSwitcher />
        <ModelSelector />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
        <Tooltip title='Prompt preview'>
          <IconButton size='small'>
            <SettingsIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title='Debug logs'>
          <IconButton size='small'>
            <BugReportIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title='Model parameters'>
          <IconButton size='small'>
            <TuneIcon />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

function ChatHeader() {
  return (
    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant='h6' sx={{ flex: 1 }}>
        通用助手
      </Typography>
      <Chip size='small' label='Web' variant='outlined' />
    </Box>
  );
}

export const Default: Story = {
  render: () => {
    const [messages, setMessages] = useState<readonly ConversationMessageListProjection[]>([]);
    const adapter = createMockAdapter({
      messages,
      sendMessage: async ({ text }) => {
        const userMessage = createMessage('user', text);
        setMessages((previous) => [...previous, userMessage]);
        setTimeout(() => {
          setMessages((previous) => [...previous, createMessage('assistant', `Echo: ${text}`)]);
        }, 600);
      },
    });

    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <AgentChatView
          adapter={adapter}
          header={<ChatHeader />}
          composerToolbar={<InlineToolbar />}
          placeholder='开始对话'
        />
      </Box>
    );
  },
};

export const WithMessages: Story = {
  render: () => {
    const [messages, setMessages] = useState<readonly ConversationMessageListProjection[]>([
      createMessage('user', '你好，介绍一下自己。'),
      createMessage('assistant', '你好！我是 MemeLoop 的通用助手，可以帮助你完成知识管理、写作、编程等任务。'),
    ]);

    const adapter = createMockAdapter({
      messages,
      sendMessage: async ({ text }) => {
        const userMessage = createMessage('user', text);
        setMessages((previous) => [...previous, userMessage]);
        setTimeout(() => {
          setMessages((previous) => [...previous, createMessage('assistant', `收到：${text}`)]);
        }, 600);
      },
    });

    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <AgentChatView
          adapter={adapter}
          header={<ChatHeader />}
          composerToolbar={<InlineToolbar />}
          placeholder='继续对话'
        />
      </Box>
    );
  },
};

export const WithConfigError: Story = {
  render: () => {
    const adapter = createMockAdapter({
      messages: [
        {
          ...createMessage('error', 'Chat.ConfigError.NoDefaultModel'),
          metadata: {
            errorDetail: { name: 'MissingConfigError' },
          },
        },
      ],
    });

    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <AgentChatView
          adapter={adapter}
          header={<ChatHeader />}
          composerToolbar={<InlineToolbar />}
          placeholder='开始对话'
        />
      </Box>
    );
  },
};

export const WithoutToolbar: Story = {
  render: () => {
    const [messages, setMessages] = useState<readonly ConversationMessageListProjection[]>([]);
    const adapter = createMockAdapter({
      messages,
      sendMessage: async ({ text }) => {
        setMessages((previous) => [...previous, createMessage('user', text)]);
      },
    });

    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <AgentChatView
          adapter={adapter}
          header={<ChatHeader />}
          placeholder='只有输入框，没有工具栏'
        />
      </Box>
    );
  },
};
