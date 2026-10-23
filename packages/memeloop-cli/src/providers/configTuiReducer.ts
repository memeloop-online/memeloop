import type { ModelCatalogProvider, ProviderModelRoute } from 'memeloop';

import type { EditState } from './configTuiTypes.js';

export interface ProviderFormState {
  readonly addName: string;
  readonly addBaseUrl: string;
  readonly addApiKey: string;
  readonly addModels: readonly ProviderModelRoute[];
  readonly addCatalogProvider?: ModelCatalogProvider;
  readonly addFieldIndex: number;
  readonly editState: EditState | null;
}

export const initialProviderFormState: ProviderFormState = {
  addName: '',
  addBaseUrl: '',
  addApiKey: '',
  addModels: [],
  addFieldIndex: 0,
  editState: null,
};

export type ProviderFormAction =
  | { readonly type: 'reset-add' }
  | {
    readonly type: 'select-preset';
    readonly providerId: string;
    readonly baseUrl: string;
    readonly models: readonly ProviderModelRoute[];
    readonly catalogProvider?: ModelCatalogProvider;
  }
  | { readonly type: 'set-add-field-index'; readonly index: number }
  | { readonly type: 'set-add-value'; readonly field: 'addName' | 'addBaseUrl' | 'addApiKey'; readonly value: string }
  | { readonly type: 'begin-edit'; readonly state: EditState }
  | { readonly type: 'set-edit-field-index'; readonly index: number }
  | { readonly type: 'set-edit-value'; readonly field: 'providerId' | 'baseUrl' | 'apiKey'; readonly value: string }
  | { readonly type: 'clear-edit' };

/**
 * Reducer for provider form and secret-edit state. Keeping field transitions
 * pure makes keyboard behavior testable without an Ink renderer and avoids
 * stale closures when a preset or edit session is entered.
 */
export function providerFormReducer(
  state: ProviderFormState,
  action: ProviderFormAction,
): ProviderFormState {
  switch (action.type) {
    case 'reset-add':
      return { ...state, addName: '', addBaseUrl: '', addApiKey: '', addModels: [], addCatalogProvider: undefined, addFieldIndex: 0 };
    case 'select-preset':
      return {
        ...state,
        addName: action.providerId,
        addBaseUrl: action.baseUrl,
        addApiKey: '',
        addModels: [...action.models],
        ...(action.catalogProvider === undefined ? { addCatalogProvider: undefined } : { addCatalogProvider: action.catalogProvider }),
        addFieldIndex: 2,
      };
    case 'set-add-field-index':
      return { ...state, addFieldIndex: action.index };
    case 'set-add-value':
      return { ...state, [action.field]: action.value };
    case 'begin-edit':
      return { ...state, editState: action.state };
    case 'set-edit-field-index':
      return { ...state, editState: state.editState === null ? null : { ...state.editState, fieldIndex: action.index } };
    case 'set-edit-value':
      return { ...state, editState: state.editState === null ? null : { ...state.editState, [action.field]: action.value } };
    case 'clear-edit':
      return { ...state, editState: null };
  }
}
