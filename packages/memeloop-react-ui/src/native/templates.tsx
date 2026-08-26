/**
 * React Native Paper-based templates for RJSF.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import type { TemplatesType } from '@rjsf/utils';
import React from 'react';

function getRn(): {
  View: React.ComponentType<{ style?: unknown; children?: React.ReactNode }>;
  Text: React.ComponentType<{ style?: unknown; children?: React.ReactNode }>;
} | null {
  try {
    // 可选 peer：RN 宿主才安装 react-native
    return require('react-native') as ReturnType<typeof getRn>;
  } catch {
    return null;
  }
}

const FieldTemplate: NonNullable<TemplatesType['FieldTemplate']> = (props) => {
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

const ObjectFieldTemplate: NonNullable<TemplatesType['ObjectFieldTemplate']> = (props) => {
  const RN = getRn();
  if (!RN?.View) {
    return <React.Fragment>{props.properties.map((p) => p.content)}</React.Fragment>;
  }
  return <RN.View style={{ gap: 8 }}>{props.properties.map((p) => p.content)}</RN.View>;
};

const ArrayFieldTemplate: NonNullable<TemplatesType['ArrayFieldTemplate']> = (props) => {
  const RN = getRn();
  if (!RN?.View) {
    return <React.Fragment>{props.items}</React.Fragment>;
  }
  return (
    <RN.View style={{ gap: 8 }}>
      {props.title}
      {props.items.map((item, index) => <RN.View key={item.key ?? index}>{item}</RN.View>)}
    </RN.View>
  );
};

function createErrorListTemplate(validationErrorMessage: string): NonNullable<TemplatesType['ErrorListTemplate']> {
  return props => {
    const RN = getRn();
    const errs = props.errors ?? [];
    if (errs.length === 0) return null;
    if (!RN?.View || !RN?.Text) return null;
    return (
      <RN.View style={{ marginVertical: 8 }}>
        {errs.map((_errorItem, index) => <RN.Text key={index} style={{ color: '#b00020' }}>{validationErrorMessage}</RN.Text>)}
      </RN.View>
    );
  };
}

const ErrorListTemplate = createErrorListTemplate('A configuration value is invalid.');

export const templates: Partial<TemplatesType> = {
  FieldTemplate,
  ObjectFieldTemplate,
  ArrayFieldTemplate,
  ErrorListTemplate,
};

export function createNativeTemplates(labels: { validationError: string }): Partial<TemplatesType> {
  return { ...templates, ErrorListTemplate: createErrorListTemplate(labels.validationError) };
}
