import { act, render } from '@testing-library/react';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { GiftedChat, type GiftedChatProps } from 'react-native-gifted-chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeAgentChatView, type NativeMemeLoopChatAdapter } from '../native/AgentChatView.js';

const list = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  props: undefined as GiftedChatProps['listViewProps'],
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const layout = { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } };
  const View = ({ children, onLayout }: { children?: React.ReactNode; onLayout?: (event: typeof layout) => void }) => {
    ReactModule.useLayoutEffect(() => {
      onLayout?.(layout);
    }, []);
    return ReactModule.createElement('div', undefined, children);
  };
  const FlatList = ReactModule.forwardRef(({ onLayout, ...props }: {
    onLayout?: (event: typeof layout) => void;
  } & GiftedChatProps['listViewProps'], ref) => {
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: list.scrollToIndex, scrollToOffset: list.scrollToOffset }));
    list.props = { ...props, onLayout: () => onLayout?.(layout) };
    ReactModule.useLayoutEffect(() => {
      onLayout?.(layout);
    }, []);
    return ReactModule.createElement('div');
  });
  return {
    View,
    Text: View,
    FlatList,
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    I18nManager: { isRTL: false },
    useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
  };
});

vi.mock('react-native-paper', async () => ({
  ...(await import('./nativePaperMock.js')).nativePaperControls,
  useTheme: () => ({ colors: {} }),
}));

vi.mock('react-native-gifted-chat', async () => {
  const ReactModule = await import('react');
  const native = await import('react-native');
  const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = await import('typescript');
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const { runInNewContext } = await import('node:vm');
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('react-native-gifted-chat/package.json'));
  const Empty = () => null;
  const Wrapper = ({ children }: { children?: React.ReactNode }) => children;
  const animation = {
    default: { View: native.View, createAnimatedComponent: (component: unknown) => component },
    useAnimatedStyle: (callback: () => unknown) => callback(),
    useAnimatedScrollHandler: () => undefined,
    useAnimatedReaction: () => undefined,
    useSharedValue: (value: unknown) => ReactModule.useRef({ value }).current,
    withTiming: (value: unknown) => value,
    runOnJS: (callback: unknown) => callback,
  };
  // Execute both installed components. Only native primitives, animation and unrelated
  // visual leaves are substituted; public ref handling and callback composition are real.
  const dependencies: Record<string, unknown> = {
    react: ReactModule,
    'react-native': native,
    'react-native-reanimated': { __esModule: true, ...animation },
    '@expo/react-native-action-sheet': { ActionSheetProvider: Wrapper },
    'react-native-keyboard-controller': {
      KeyboardProvider: Wrapper,
      useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }),
    },
    dayjs: { extend: () => undefined },
    'dayjs/plugin/localizedFormat': () => undefined,
    '../GiftedChatContext': { GiftedChatContext: ReactModule.createContext({}) },
    '../Constant': { MIN_COMPOSER_HEIGHT: 44, MAX_COMPOSER_HEIGHT: 200, TEST_ID: { WRAPPER: 'gifted-wrapper' } },
    '../styles': {},
    './styles': {},
    '../utils': {},
    '../types': {},
    './types': {},
    '../logging': { warning: () => undefined },
  };
  for (const name of ['Actions', 'Avatar', 'Composer', 'Day', 'GiftedAvatar', 'InputToolbar', 'LoadEarlier', 'MessageImage', 'MessageText', 'Send', 'SystemMessage', 'Time']) {
    dependencies[`../${name}`] = { [name]: Empty };
  }
  for (const name of ['../Bubble', '../Message', '../TypingIndicator', './components/DayAnimated', './components/Item']) dependencies[name] = Empty;
  const loadInstalled = (relative: string): Record<string, unknown> => {
    const filename = join(root, 'lib', relative, 'index.js');
    const { outputText: code } = transpileModule(readFileSync(filename, 'utf8'), {
      fileName: `${filename}x`,
      compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} };
    runInNewContext(code, {
      module,
      exports: module.exports,
      require: (id: string) => {
        if (!(id in dependencies)) throw Error(`Unexpected installed GiftedChat dependency: ${id}`);
        return dependencies[id];
      },
      setTimeout,
      clearTimeout,
    }, { filename });
    return module.exports;
  };
  dependencies['../MessageContainer'] = { __esModule: true, ...loadInstalled('MessageContainer') };
  return loadInstalled('GiftedChat');
});

function message(index: number): ConversationMessageListProjection {
  return {
    messageId: `message-${index}`,
    turnId: `message-${index}`,
    conversationId: 'native-contract',
    originNodeId: 'node',
    originSequence: index + 1,
    timestamp: index,
    lamportClock: index + 1,
    role: index === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  };
}

describe('installed GiftedChat native navigation contract', () => {
  beforeEach(() => {
    list.scrollToIndex.mockReset();
    list.scrollToOffset.mockReset();
  });

  it('binds messageContainerRef through the installed public component', () => {
    const publicRef = React.createRef<{ scrollToIndex: typeof list.scrollToIndex; scrollToOffset: typeof list.scrollToOffset }>();
    const internalProp = React.createRef();
    render(<GiftedChat messages={[]} messageContainerRef={publicRef} {...{ forwardRef: internalProp }} />);
    expect(publicRef.current?.scrollToIndex).toBe(list.scrollToIndex);
    expect(internalProp.current).toBeNull();
  });

  it('connects the public list ref after GiftedChat initialization and preserves host layout callbacks', () => {
    let adapter: NativeMemeLoopChatAdapter = {
      conversationId: 'native-contract',
      messages: [message(0), message(1)],
      windowAnchorMessageId: 'message-0',
      isRunning: false,
      isLoading: false,
      error: null,
      sendMessage: vi.fn(),
      cancel: vi.fn(),
      deleteTurn: vi.fn(),
      retryTurn: vi.fn(),
    };
    const view = () => <NativeAgentChatView adapter={adapter} resolveErrorPresentation={() => null} genericErrorPresentation={{ title: 'Error', message: 'Retry' }} />;
    const mounted = render(view());
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(list.scrollToIndex).toHaveBeenCalledWith({ animated: true, index: 1, viewPosition: 0.5 });
    for (let tick = 0; tick < 20; tick += 1) {
      adapter = { ...adapter, messages: [message(0), { ...message(1), content: `stream ${tick}` }] };
      mounted.rerender(view());
    }
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);

    list.scrollToIndex.mockImplementationOnce(() => list.props?.onScrollToIndexFailed?.({ averageItemLength: 80, highestMeasuredFrameIndex: 0, index: 0 }));
    adapter = { ...adapter, windowAnchorMessageId: 'message-1' };
    mounted.rerender(view());
    expect(list.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 0 });
    act(() => list.props?.onLayout?.());
    expect(list.scrollToIndex).toHaveBeenCalledTimes(3);
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({ animated: true, index: 0, viewPosition: 0.5 });
    act(() => list.props?.onContentSizeChange?.());
    expect(list.scrollToIndex).toHaveBeenCalledTimes(3);
  });
});
