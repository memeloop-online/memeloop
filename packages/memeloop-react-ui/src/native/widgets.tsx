/**
 * React Native Paper-based widgets for RJSF.
 * Optional peer: react-native-paper. When absent, returns empty fragments.
 */

import type { WidgetProps } from "@rjsf/utils";
import React from "react";

type PaperModule = {
  TextInput?: React.ComponentType<{
    mode?: string;
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    keyboardType?: string;
    onChangeText?: (text: string) => void;
    onBlur?: () => void;
    style?: unknown;
  }>;
  Checkbox?: { Item: React.ComponentType<{ label: string; status: string; onPress: () => void; disabled?: boolean }> };
  Menu?: React.ComponentType<{
    visible: boolean;
    onDismiss: () => void;
    anchor: React.ReactNode;
    children?: React.ReactNode;
  }> & { Item?: React.ComponentType<{ onPress?: () => void; title: string }> };
  RadioButton?: {
    Item: React.ComponentType<{
      value: string;
      status: string;
      onPress: () => void;
      label: string;
      disabled?: boolean;
    }>;
  };
  Button?: React.ComponentType<{
    mode?: string;
    onPress?: () => void;
    children?: React.ReactNode;
    disabled?: boolean;
  }>;
};

function getPaper(): PaperModule | null {
  try {
    return require("react-native-paper") as PaperModule;
  } catch {
    return null;
  }
}

type RnMinimal = {
  View: React.ComponentType<{ style?: unknown; children?: React.ReactNode; key?: string }>;
};

function getRn(): RnMinimal | null {
  try {
    return require("react-native") as RnMinimal;
  } catch {
    return null;
  }
}

/** Text input widget using React Native Paper TextInput */
export function TextWidget(props: WidgetProps): React.ReactElement {
  const { id, value, readonly, disabled, placeholder, onChange, onBlur } = props;
  const Paper = getPaper();
  if (!Paper?.TextInput) {
    return <React.Fragment />;
  }
  return (
    <Paper.TextInput
      mode="outlined"
      value={(value as string) ?? ""}
      placeholder={placeholder}
      disabled={disabled ?? readonly}
      onChangeText={(text: string) => onChange(text === "" ? undefined : text)}
      onBlur={() => onBlur(id, (value as string) ?? "")}
      style={{ marginBottom: 8 }}
    />
  );
}

/** Checkbox widget using React Native Paper Checkbox */
export function CheckboxWidget(props: WidgetProps): React.ReactElement {
  const { value, disabled, onChange } = props;
  const Paper = getPaper();
  if (!Paper?.Checkbox) {
    return <React.Fragment />;
  }
  return (
    <Paper.Checkbox.Item
      label=""
      status={value ? "checked" : "unchecked"}
      onPress={() => onChange(!value)}
      disabled={disabled}
    />
  );
}

/** Number: numeric keyboard TextInput */
export function NumberWidget(props: WidgetProps): React.ReactElement {
  const { id, value, readonly, disabled, placeholder, onChange, onBlur } = props;
  const Paper = getPaper();
  if (!Paper?.TextInput) {
    return <React.Fragment />;
  }
  const str = value === undefined || value === null ? "" : String(value);
  return (
    <Paper.TextInput
      mode="outlined"
      keyboardType="numeric"
      value={str}
      placeholder={placeholder}
      disabled={disabled ?? readonly}
      onChangeText={(text: string) => {
        if (text === "" || text === "-") {
          onChange(undefined);
          return;
        }
        const n = Number(text);
        onChange(Number.isFinite(n) ? n : text);
      }}
      onBlur={() => onBlur(id, str)}
      style={{ marginBottom: 8 }}
    />
  );
}

/** Select: Paper Menu + Button（enum options 来自 schema.enum） */
export function SelectWidget(props: WidgetProps): React.ReactElement {
  const { schema, value, disabled, readonly, onChange } = props;
  const Paper = getPaper();
  const RN = getRn();
  if (!Paper?.Menu || !Paper.Button || !RN) {
    return <React.Fragment />;
  }
  const MenuItem = Paper.Menu.Item;
  if (!MenuItem) {
    return <React.Fragment />;
  }
  const options = (Array.isArray(schema.enum) ? schema.enum : []) as (string | number)[];
  const [open, setOpen] = React.useState(false);
  const label = value === undefined || value === null ? "选择…" : String(value);
  const ro = Boolean(disabled ?? readonly);
  return (
    <Paper.Menu
      visible={open}
      onDismiss={() => setOpen(false)}
      anchor={
        <Paper.Button
          mode="outlined"
          disabled={ro}
          onPress={() => {
            if (ro) return;
            setOpen(true);
          }}
        >
          {label}
        </Paper.Button>
      }
    >
      {options.map((opt) => (
        <MenuItem
          key={String(opt)}
          title={String(opt)}
          onPress={() => {
            onChange(opt);
            setOpen(false);
          }}
        />
      ))}
    </Paper.Menu>
  );
}

/** Radio group for enum */
export function RadioWidget(props: WidgetProps): React.ReactElement {
  const { schema, value, disabled, readonly, onChange } = props;
  const Paper = getPaper();
  const RN = getRn();
  const RbItem = Paper?.RadioButton?.Item;
  if (!RbItem || !RN?.View) {
    return <React.Fragment />;
  }
  const options = (Array.isArray(schema.enum) ? schema.enum : []) as (string | number)[];
  const ro = Boolean(disabled ?? readonly);
  return (
    <RN.View style={{ gap: 4 }}>
      {options.map((opt) => {
        const s = String(opt);
        return (
          <RbItem
            key={s}
            value={s}
            label={s}
            status={value === opt ? "checked" : "unchecked"}
            onPress={() => {
              if (ro) return;
              onChange(opt);
            }}
            disabled={ro}
          />
        );
      })}
    </RN.View>
  );
}

/** Widgets map for use with RJSF Form */
export function getNativeWidgets(): Record<string, React.ComponentType<WidgetProps>> {
  return {
    TextWidget,
    CheckboxWidget,
    textarea: TextWidget,
    SelectWidget,
    radio: RadioWidget,
    RadioWidget,
    number: NumberWidget,
    integer: NumberWidget,
  };
}
