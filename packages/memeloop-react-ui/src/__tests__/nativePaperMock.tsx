import React from 'react';
export const nativePaperControls = {
  TextInput: ({ accessibilityLabel, value, disabled, onChangeText, onKeyPress }: {
    accessibilityLabel?: string;
    value?: string;
    disabled?: boolean;
    onChangeText?: (value: string) => void;
    onKeyPress?: (event: { nativeEvent: { key: string } }) => void;
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      value={value}
      disabled={disabled}
      onChange={event => onChangeText?.(event.target.value)}
      onKeyDown={event => onKeyPress?.({ nativeEvent: { key: event.key } })}
    />
  ),
  Button: ({ children, onPress, disabled }: { children?: React.ReactNode; onPress?: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onPress}>{children}</button>
  ),
  IconButton: ({ accessibilityLabel, onPress, disabled }: { accessibilityLabel?: string; onPress?: () => void; disabled?: boolean }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress} />
  ),
  Menu: Object.assign(
    ({ anchor, visible, children, onDismiss }: { anchor: React.ReactNode; visible: boolean; children?: React.ReactNode; onDismiss: () => void }) => (
      <div>
        {anchor}
        {visible && (
          <div role='menu'>
            {children}
            <button onClick={onDismiss}>Dismiss menu</button>
          </div>
        )}
      </div>
    ),
    {
      Item: ({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress?: () => void }) => (
        <button role='menuitem' disabled={disabled} onClick={onPress}>{title}</button>
      ),
    },
  ),
};
