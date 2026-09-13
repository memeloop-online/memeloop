import { describe, expect, it } from 'vitest';

import { initialProviderFormState, providerFormReducer } from '../configTuiReducer.js';

describe('provider configuration form reducer', () => {
  it('resets add fields without leaking a previous secret or catalog', () => {
    const selected = providerFormReducer(initialProviderFormState, {
      type: 'select-preset',
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ modelId: 'gpt-5', wireModelId: 'gpt-5', apiMode: 'responses' }],
    });
    const withKey = providerFormReducer(selected, { type: 'set-add-value', field: 'addApiKey', value: 'secret' });
    const reset = providerFormReducer(withKey, { type: 'reset-add' });
    expect(reset.addName).toBe('');
    expect(reset.addApiKey).toBe('');
    expect(reset.addModels).toEqual([]);
    expect(reset.addCatalogProvider).toBeUndefined();
    expect(reset.addFieldIndex).toBe(0);
  });

  it('updates edit fields immutably and ignores updates before edit begins', () => {
    const ignored = providerFormReducer(initialProviderFormState, { type: 'set-edit-field-index', index: 2 });
    expect(ignored.editState).toBeNull();
    const editing = providerFormReducer(initialProviderFormState, {
      type: 'begin-edit',
      state: {
        origProviderId: '供应商1',
        providerId: '供应商1',
        providerType: 'openai-compatible',
        baseUrl: '',
        apiKey: '',
        fieldIndex: 0,
      },
    });
    const changed = providerFormReducer(editing, { type: 'set-edit-value', field: 'apiKey', value: 'new-secret' });
    expect(editing.editState?.apiKey).toBe('');
    expect(changed.editState?.apiKey).toBe('new-secret');
    expect(changed.editState?.origProviderId).toBe('供应商1');
  });
});
