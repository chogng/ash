import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { buildModelPickerItems } from '../../browser/widget/input/modelPicker/modelPickerItems.js';

test('The unified catalog preserves order and exact identities and labels only duplicate names with their source', () => {
	const models: ModelCatalogEntry[] = [
		{ model: { provider: 'team-b', model: 'shared' }, displayName: 'Shared model', longContext: null },
		{ model: { provider: 'openai', model: 'unique' }, displayName: 'Unique model', longContext: null },
		{ model: { provider: 'team-a', model: 'shared' }, displayName: 'Shared model', longContext: null },
	];
	const items = buildModelPickerItems(models, models[2]!.model);
	assert.deepEqual(items.map(({ id, label, description, checked, item }) => ({ id, label, description, checked, model: item?.model })), [
		{ id: 'team-b/shared', label: 'Shared model', description: 'team-b', checked: false, model: models[0]!.model },
		{ id: 'openai/unique', label: 'Unique model', description: undefined, checked: false, model: models[1]!.model },
		{ id: 'team-a/shared', label: 'Shared model', description: 'team-a', checked: true, model: models[2]!.model },
	]);
});
