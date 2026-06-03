/**
 * React Native Paper-based templates for RJSF.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-base-to-string */

import type { TemplatesType } from "@rjsf/utils";
import React from "react";

function getRn(): {
  View: React.ComponentType<{ style?: unknown; children?: React.ReactNode }>;
  Text: React.ComponentType<{ style?: unknown; children?: React.ReactNode }>;
} | null {
  try {
    // 可选 peer：RN 宿主才安装 react-native
    return require("react-native") as ReturnType<typeof getRn>;
  } catch {
    return null;
  }
}

const FieldTemplate: NonNullable<TemplatesType["FieldTemplate"]> = (props) => {
  const RN = getRn();
  if (!RN?.View || !RN?.Text) {
    return <React.Fragment>{props.children}</React.Fragment>;
  }
  return (
    <RN.View style={{ marginBottom: 12 }}>
      {props.label}
      {props.description}
      {props.children}
      {props.errors}
      {props.help}
    </RN.View>
  );
};

const ObjectFieldTemplate: NonNullable<TemplatesType["ObjectFieldTemplate"]> = (props) => {
  const RN = getRn();
  if (!RN?.View) {
    return <React.Fragment>{props.properties.map((p) => p.content)}</React.Fragment>;
  }
  return <RN.View style={{ gap: 8 }}>{props.properties.map((p) => p.content)}</RN.View>;
};

const ArrayFieldTemplate: NonNullable<TemplatesType["ArrayFieldTemplate"]> = (props) => {
  const RN = getRn();
  if (!RN?.View) {
    return <React.Fragment>{props.items.map((item) => item.children)}</React.Fragment>;
  }
  return (
    <RN.View style={{ gap: 8 }}>
      {props.title}
      {props.items.map((item) => (
        <RN.View key={item.key}>{item.children}</RN.View>
      ))}
    </RN.View>
  );
};

const ErrorListTemplate: NonNullable<TemplatesType["ErrorListTemplate"]> = (props) => {
  const RN = getRn();
  const errs = props.errors ?? [];
  if (errs.length === 0) return null;
  if (!RN?.View || !RN?.Text) return null;
  return (
    <RN.View style={{ marginVertical: 8 }}>
      {errs.map((errorItem, index) => (
        <RN.Text key={index} style={{ color: "#b00020" }}>
          {typeof errorItem === "string"
            ? errorItem
            : ((errorItem as { message?: string }).message ?? String(errorItem))}
        </RN.Text>
      ))}
    </RN.View>
  );
};

export const templates: Partial<TemplatesType> = {
  FieldTemplate,
  ObjectFieldTemplate,
  ArrayFieldTemplate,
  ErrorListTemplate,
};
