import type { Icon } from '../../../../../../../base/common/icon.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../../nls.js';
import { registerIcon } from '../../../../../../../platform/theme/common/iconRegistry.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

const generic = registerIcon('chat-model-provider-generic', Lxicon.sparkle, localize('chat.modelPicker.icon.generic', 'Icon for a model provider.'));
const genericCompact = registerIcon('chat-model-provider-generic-compact', Lxicon.sparkle, localize('chat.modelPicker.icon.genericCompact', 'Compact icon for a model provider.'));
const openai = providerIcon('openai', Lxicon.openai, 'OpenAI');
const claude = providerIcon('claude', Lxicon.claude, 'Anthropic');
const gemini = providerIcon('gemini', Lxicon.sparkle, 'Gemini');
const deepseek = providerIcon('deepseek', Lxicon.sparkle, 'DeepSeek');
const qwen = providerIcon('qwen', Lxicon.sparkle, 'Qwen');
const xai = providerIcon('xai', Lxicon.sparkle, 'Grok');

function providerIcon(id: string, artwork: Icon, name: string): Icon {
	return registerIcon(`chat-model-provider-${id}`, artwork, localize('chat.modelPicker.icon.provider', 'Icon for {0} models.', name));
}

/** Connection identities are authoritative; a model's display name never determines its provider. */
export function getProviderIconForIdentity(identity: string): Icon {
	switch (identity.toLowerCase()) {
		case 'openai': case 'gpt': return openai;
		case 'anthropic': case 'claude': return claude;
		case 'google': case 'gemini': return gemini;
		case 'deepseek': return deepseek;
		case 'qwen': return qwen;
		case 'xai': case 'grok': return xai;
		default: return generic;
	}
}

export function getModelProviderIcon(model: ModelCatalogEntry): Icon {
	return getProviderIconForIdentity(model.model.provider);
}

export function getCompactModelPickerIcon(model: ModelCatalogEntry): Icon {
	const icon = getModelProviderIcon(model);
	return icon === generic ? genericCompact : icon;
}
