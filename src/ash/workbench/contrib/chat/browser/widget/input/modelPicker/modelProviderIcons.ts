import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

const providerIcons = new Map([
	['openai', Lxicon.openai],
	['anthropic', Lxicon.claude],
	['google', Lxicon.gemini],
	['gemini', Lxicon.gemini],
	['xai', Lxicon.grok],
	['deepseek', Lxicon.deepseek],
]);

/** Named connections retain the catalog's provider identity, including unbranded custom endpoints. */
export function getModelProviderIcon(model: ModelCatalogEntry) {
	return providerIcons.get(model.source?.providerId ?? model.model.provider);
}
