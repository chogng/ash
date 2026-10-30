import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { getCompactModelPickerIcon, getModelProviderIcon, getProviderIconForIdentity } from '../../browser/widget/input/modelPicker/modelProviderIcons.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';

test('Provider icon identities remain distinct and a custom connection never inherits a model-name brand', () => {
	assert.deepEqual(['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'xai', 'team-endpoint'].map(identity => getProviderIconForIdentity(identity).id), [
		'chat-model-provider-openai', 'chat-model-provider-claude', 'chat-model-provider-gemini',
		'chat-model-provider-deepseek', 'chat-model-provider-qwen', 'chat-model-provider-xai', 'chat-model-provider-generic',
	]);
	const custom: ModelCatalogEntry = { model: { provider: 'team-endpoint', model: 'gpt-6.1-sol' }, displayName: 'Claude', longContext: null };
	assert.equal(getModelProviderIcon(custom).id, 'chat-model-provider-generic');
	assert.equal(getCompactModelPickerIcon(custom).id, 'chat-model-provider-generic-compact');
	assert.equal(getIconDefinition(getProviderIconForIdentity('openai'))?.fontCharacter, getIconDefinition(Lxicon.openai)?.fontCharacter);
	assert.equal(getIconDefinition(getProviderIconForIdentity('claude'))?.fontCharacter, getIconDefinition(Lxicon.claude)?.fontCharacter);
});
