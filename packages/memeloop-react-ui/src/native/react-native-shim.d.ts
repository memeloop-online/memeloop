/** Optional peer modules: resolved by React Native hosts, stubbed for package dts builds. */
declare module 'react-native' {
  import type { ComponentType, ReactNode } from 'react';

  export const View: ComponentType<{ style?: unknown; children?: ReactNode }>;
  export const Text: ComponentType<{ style?: unknown; children?: ReactNode }>;
  export const Pressable: ComponentType<{ disabled?: boolean; onPress?: () => void; style?: unknown; children?: ReactNode }>;
  export const FlatList: <ItemT>(props: {
    data: readonly ItemT[];
    keyExtractor?: (item: ItemT, index: number) => string;
    renderItem: (info: { item: ItemT; index: number }) => ReactNode;
    style?: unknown;
  }) => ReactNode;
  export const StyleSheet: {
    create<T extends Record<string, unknown>>(styles: T): T;
  };
}

declare module 'react-native-gifted-chat' {
  import type { ReactNode } from 'react';

  export interface IMessage {
    _id: string;
    text: string;
    createdAt: number | Date;
    user: User;
  }

  export interface User {
    _id: string;
    name?: string;
    avatar?: string | number;
  }

  export interface GiftedChatProps<TMessage extends IMessage = IMessage> {
    messages: TMessage[];
    onSend?: (messages: TMessage[]) => void;
    user?: User;
    placeholder?: string;
    isTyping?: boolean;
    onLongPress?: (context: unknown, message: TMessage) => void;
    onDelete?: (message: TMessage) => void;
    inverted?: boolean;
    renderMessage?: (props: Record<string, unknown>) => ReactNode;
    renderCustomView?: (message: TMessage) => ReactNode;
  }

  export function GiftedChat<TMessage extends IMessage = IMessage>(
    props: GiftedChatProps<TMessage>,
  ): ReactNode;
}

declare module 'react-native-paper' {
  import type { ComponentType, ReactNode } from 'react';

  export const ActivityIndicator: ComponentType<Record<string, never>>;
  export const Button: ComponentType<{
    children?: ReactNode;
    disabled?: boolean;
    mode?: string;
    onPress?: () => void;
  }>;
  export const Card:
    & ComponentType<{
      children?: ReactNode;
      mode?: string;
      style?: unknown;
    }>
    & {
      Content: ComponentType<{ children?: ReactNode }>;
    };
  export const IconButton: ComponentType<{
    accessibilityLabel?: string;
    icon: string;
    onPress?: () => void;
  }>;
  export const Text: ComponentType<{
    children?: ReactNode;
    style?: unknown;
    variant?: string;
  }>;
  export const TextInput: ComponentType<{
    disabled?: boolean;
    mode?: string;
    multiline?: boolean;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    style?: unknown;
    value?: string;
  }>;
}
