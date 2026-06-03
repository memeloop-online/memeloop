/**
 * Array item context for RJSF array fields.
 * Platform-agnostic: only React, no MUI or other UI. Used by templates to know
 * if we're inside an array item and to pass item index/path to children.
 */

import React, { createContext, useContext, useMemo } from "react";

export interface ArrayItemContextValue {
  isInArrayItem: boolean;
  arrayItemCollapsible: boolean;
  itemData?: unknown;
  itemIndex?: number;
  arrayFieldPath?: string;
  arrayFieldPathSegments?: Array<string | number>;
}

const defaultValue: ArrayItemContextValue = {
  isInArrayItem: false,
  arrayItemCollapsible: false,
};

const ArrayItemContext = createContext<ArrayItemContextValue>(defaultValue);

export function useArrayItemContext(): ArrayItemContextValue {
  return useContext(ArrayItemContext);
}

export interface ArrayItemProviderProps {
  children: React.ReactNode;
  isInArrayItem: boolean;
  arrayItemCollapsible?: boolean;
  itemData?: unknown;
  itemIndex?: number;
  arrayFieldPath?: string;
  arrayFieldPathSegments?: Array<string | number>;
}

export function ArrayItemProvider({
  children,
  isInArrayItem,
  arrayItemCollapsible = false,
  itemData,
  itemIndex,
  arrayFieldPath,
  arrayFieldPathSegments,
}: ArrayItemProviderProps): React.ReactElement {
  const value = useMemo<ArrayItemContextValue>(
    () => ({
      isInArrayItem,
      arrayItemCollapsible,
      itemData,
      itemIndex,
      arrayFieldPath,
      arrayFieldPathSegments,
    }),
    [
      isInArrayItem,
      arrayItemCollapsible,
      itemData,
      itemIndex,
      arrayFieldPath,
      arrayFieldPathSegments,
    ],
  );

  return (
    <ArrayItemContext.Provider value={value}>
      {children}
    </ArrayItemContext.Provider>
  );
}
