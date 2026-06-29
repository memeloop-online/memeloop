import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Card, CardContent, IconButton, Tab, Tabs, Typography } from '@mui/material';
import type { ArrayFieldTemplateProps, FieldTemplateProps, ObjectFieldTemplateProps, TemplatesType } from '@rjsf/utils';
import React, { useEffect, useState } from 'react';

import { HelpTooltip } from './HelpTooltip.js';

type PromptEditorFormContext = {
  formFieldsToScrollTo?: string[];
};

const FieldTemplate: NonNullable<TemplatesType['FieldTemplate']> = (props: FieldTemplateProps) => {
  const {
    id,
    children,
    errors,
    help,
    schema,
    hidden,
    required,
    displayLabel,
    label,
  } = props;

  if (hidden) {
    return <div style={{ display: 'none' }}>{children}</div>;
  }

  return (
    <Box sx={{ mb: 1.5 }}>
      {displayLabel && label && (
        <Box component='label' htmlFor={id} sx={{ display: 'block', mb: 0.5 }}>
          <Typography component='span' sx={{ fontSize: '0.875rem', fontWeight: 600 }}>
            {label}
            {required ? ' *' : ''}
            {typeof schema.description === 'string' && schema.description ? <HelpTooltip title={schema.description} /> : null}
          </Typography>
        </Box>
      )}
      {children}
      {errors}
      {help}
    </Box>
  );
};

const ObjectFieldTemplate: NonNullable<TemplatesType['ObjectFieldTemplate']> = (props: ObjectFieldTemplateProps) => {
  const compactFieldsValue = (props.uiSchema as Record<string, unknown> | undefined)?.['ui:compactFields'];
  const compactFields = Array.isArray(compactFieldsValue) ? compactFieldsValue.filter((item): item is string => typeof item === 'string') : [];
  const useCompactLayout = compactFields.length > 0;

  const compactProperties = props.properties.filter((property) => compactFields.includes(property.name));
  const normalProperties = props.properties.filter((property) => !compactFields.includes(property.name));

  return (
    <Card variant='outlined' sx={{ mb: 1 }}>
      <CardContent sx={{ pb: '16px !important' }}>
        {props.schema.title
          ? (
            <Box sx={{ mb: 2 }}>
              <Typography sx={{ fontSize: '1rem', fontWeight: 700 }}>
                {props.schema.title}
                {props.schema.description ? <HelpTooltip title={props.schema.description} /> : null}
              </Typography>
            </Box>
          )
          : null}
        {useCompactLayout
          ? (
            <>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', mb: compactProperties.length > 0 ? 1 : 0 }}>
                {compactProperties.map((property) => <Box key={property.name}>{property.content}</Box>)}
              </Box>
              {normalProperties.map((property) => (
                <Box key={property.name} sx={{ mb: 0.5 }}>
                  {property.content}
                </Box>
              ))}
            </>
          )
          : (
            props.properties.map((property) => (
              <Box key={property.name} sx={{ mb: 0.5 }}>
                {property.content}
              </Box>
            ))
          )}
      </CardContent>
    </Card>
  );
};

const RootObjectFieldTemplate: NonNullable<TemplatesType['ObjectFieldTemplate']> = (props: ObjectFieldTemplateProps) => {
  const [activeTab, setActiveTab] = useState(0);
  const formContext = props.registry.formContext as PromptEditorFormContext | undefined;
  const formFieldsToScrollTo = formContext?.formFieldsToScrollTo ?? [];

  useEffect(() => {
    if (formFieldsToScrollTo.length === 0) return;
    const targetTab = formFieldsToScrollTo[0];
    const tabIndex = props.properties.findIndex((property) => property.name === targetTab);
    if (tabIndex >= 0) {
      setActiveTab(tabIndex);
    }
  }, [formFieldsToScrollTo, props.properties]);

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs
          value={activeTab}
          onChange={(_event: object, newValue: number) => {
            setActiveTab(newValue);
          }}
          variant='scrollable'
          scrollButtons='auto'
          aria-label='configuration sections'
        >
          {props.properties.map((property, index) => {
            const fieldSchema = props.schema.properties?.[property.name];
            const title = typeof fieldSchema === 'object' && fieldSchema && 'title' in fieldSchema && typeof fieldSchema.title === 'string'
              ? fieldSchema.title
              : property.name;
            return <Tab key={property.name} label={title} id={`config-tab-${index}`} aria-controls={`config-tabpanel-${index}`} sx={{ textTransform: 'none', minWidth: 120 }} />;
          })}
        </Tabs>
      </Box>
      {props.properties.map((property, index) => (
        <Box
          key={property.name}
          role='tabpanel'
          hidden={activeTab !== index}
          id={`config-tabpanel-${index}`}
          aria-labelledby={`config-tab-${index}`}
          sx={{ width: '100%' }}
        >
          {activeTab === index ? property.content : null}
        </Box>
      ))}
    </Box>
  );
};

const ArrayFieldTemplate: NonNullable<TemplatesType['ArrayFieldTemplate']> = (props: ArrayFieldTemplateProps) => {
  const description = typeof props.schema.description === 'string' ? props.schema.description : '';
  const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({});

  const toggleExpanded = (index: number) => {
    setExpandedItems((previous) => ({
      ...previous,
      [index]: !previous[index],
    }));
  };

  return (
    <Box sx={{ mb: 2 }}>
      {props.title
        ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography sx={{ fontSize: '0.95rem', fontWeight: 700 }}>{props.title}</Typography>
            {description ? <HelpTooltip title={description} /> : null}
          </Box>
        )
        : null}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {props.items.map((item, index) => {
          const expanded = expandedItems[index];
          return (
            <Card key={item.key ?? index} variant='outlined'>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1 }}>
                <Typography sx={{ fontSize: '0.875rem', fontWeight: 600 }}>
                  {`${props.title ?? 'Item'} ${index + 1}`}
                </Typography>
                <IconButton
                  size='small'
                  title='展开'
                  aria-label='展开'
                  onClick={() => {
                    toggleExpanded(index);
                  }}
                >
                  <ExpandMoreIcon sx={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease-in-out' }} />
                </IconButton>
              </Box>
              {expanded && <Box sx={{ px: 2, pb: 2 }}>{item}</Box>}
            </Card>
          );
        })}
      </Box>
    </Box>
  );
};

export const templates: Partial<TemplatesType> = {
  FieldTemplate,
  ObjectFieldTemplate: (props: ObjectFieldTemplateProps): React.JSX.Element => {
    const fieldPathId = (props as ObjectFieldTemplateProps & { fieldPathId?: { $id?: string } }).fieldPathId;
    const isRootLevel = fieldPathId?.$id === 'root';
    return isRootLevel ? <RootObjectFieldTemplate {...props} /> : <ObjectFieldTemplate {...props} />;
  },
  ArrayFieldTemplate,
};
