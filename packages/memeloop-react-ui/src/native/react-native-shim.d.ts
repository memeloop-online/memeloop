/** Optional peer modules: resolved by React Native hosts, stubbed for package dts builds. */
declare module 'react-native' {
  import type { ComponentType, ReactNode } from 'react';

  export const I18nManager: { isRTL: boolean };
  export const Platform: { OS: string };
  export const BackHandler: { addEventListener: (event: 'hardwareBackPress', handler: () => boolean) => { remove: () => void } };
  export const Image: ComponentType<{ accessibilityLabel?: string; resizeMode?: string; source: { uri: string }; style?: unknown }>;
  export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number };
  export const View: ComponentType<
    {
      testID?: string;
      accessibilityElementsHidden?: boolean;
      importantForAccessibility?: string;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      style?: unknown;
      children?: ReactNode;
    }
  >;
  export const Text: ComponentType<
    { testID?: string; selectable?: boolean; accessibilityLabel?: string; accessibilityRole?: string; numberOfLines?: number; style?: unknown; children?: ReactNode }
  >;
  export const Pressable: ComponentType<
    {
      testID?: string;
      accessibilityHint?: string;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { disabled?: boolean; selected?: boolean; expanded?: boolean };
      disabled?: boolean;
      onPress?: () => void;
      onHoverIn?: () => void;
      onHoverOut?: () => void;
      onFocus?: () => void;
      style?: unknown;
      children?: ReactNode;
    }
  >;
  export const ScrollView: ComponentType<{ contentContainerStyle?: unknown; style?: unknown; children?: ReactNode }>;
  export const TextInput: ComponentType<{
    autoFocus?: boolean;
    editable?: boolean;
    onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
    accessibilityLabel?: string;
    keyboardType?: string;
    multiline?: boolean;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    style?: unknown;
    value?: string;
  }>;
  export const Modal: ComponentType<{
    animationType?: string;
    children?: ReactNode;
    onRequestClose?: () => void;
    transparent?: boolean;
    visible?: boolean;
  }>;
  export const FlatList: <ItemT>(props: {
    data: readonly ItemT[];
    keyExtractor?: (item: ItemT, index: number) => string;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
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
    image?: string;
  }

  export interface User {
    _id: string;
    name?: string;
    avatar?: string | number;
  }

  export interface GiftedChatProps<TMessage extends IMessage = IMessage> {
    forwardRef?: { current: { scrollToIndex: (options: { animated?: boolean; index: number; viewPosition?: number }) => void } | null };
    messages: TMessage[];
    onSend?: (messages: TMessage[]) => void;
    user?: User;
    placeholder?: string;
    isTyping?: boolean;
    onLongPress?: (context: unknown, message: TMessage) => void;
    onDelete?: (message: TMessage) => void;
    inverted?: boolean;
    renderMessage?: (props: Record<string, unknown>) => ReactNode;
    renderMessageText?: (props: { currentMessage?: TMessage }) => ReactNode;
    renderBubble?: (props: { currentMessage?: TMessage }) => ReactNode;
    renderCustomView?: (props: { currentMessage?: TMessage }) => ReactNode;
    renderActions?: (props: Record<string, unknown>) => ReactNode;
    renderAccessory?: (props: Record<string, unknown>) => ReactNode;
    loadEarlier?: boolean;
    isLoadingEarlier?: boolean;
    loadEarlierLabel?: string;
    onLoadEarlier?: () => void;
    textInputProps?: { editable?: boolean };
    listViewProps?: {
      onViewableItemsChanged?: (input: { viewableItems?: readonly { isViewable?: boolean; item?: TMessage }[] }) => void;
      viewabilityConfig?: { itemVisiblePercentThreshold?: number };
    };
  }

  export function GiftedChat<TMessage extends IMessage = IMessage>(
    props: GiftedChatProps<TMessage>,
  ): ReactNode;
  export function Bubble(props: { currentMessage?: IMessage; onPress?: () => void; onLongPress?: () => void }): ReactNode;
}

declare module 'react-native-paper' {
  import type { ComponentType, ReactNode } from 'react';

  export interface MD3Colors {
    backdrop: string;
    error: string;
    inverseOnSurface: string;
    inverseSurface: string;
    onPrimary: string;
    onPrimaryContainer: string;
    onSurface: string;
    onSurfaceVariant: string;
    outline: string;
    primary: string;
    primaryContainer: string;
    surface: string;
    surfaceVariant: string;
  }

  export function useTheme(): { colors: MD3Colors };

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
    label?: string;
    keyboardType?: 'numeric' | 'decimal-pad' | 'default';
    mode?: string;
    multiline?: boolean;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    style?: unknown;
    value?: string;
  }>;
}
