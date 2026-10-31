import { localize } from '../../../../../../../nls.js';
import type { ModelProviderCredentialStatus } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

export interface IModelPickerProviderPlaceholder {
	readonly vendor: string;
	readonly label: string;
	readonly message: string;
	readonly action?: { readonly label: string; readonly run: () => void; };
}

export interface IModelPickerDestination {
	readonly id: string;
	readonly label: string;
	readonly models: readonly ModelCatalogEntry[];
	readonly placeholders: readonly IModelPickerProviderPlaceholder[];
}

const providerLabels: Readonly<Record<string, string>> = {
	openai: 'GPT', anthropic: 'Claude', google: 'Gemini', gemini: 'Gemini',
	deepseek: 'DeepSeek', qwen: 'Qwen', xai: 'Grok',
};

/** Groups the visible catalog without changing its order, identities or connection ownership. */
export function buildModelPickerDestinations(
	models: readonly ModelCatalogEntry[],
	providers: readonly ModelProviderCredentialStatus[],
	placeholders: readonly IModelPickerProviderPlaceholder[] = [],
): readonly IModelPickerDestination[] {
	const labels = new Map(providers.map(provider => [provider.connection, provider.displayName]));
	for (const provider of providers) {
		if (!labels.has(provider.provider)) { labels.set(provider.provider, provider.displayName); }
	}
	const groups = new Map<string, ModelCatalogEntry[]>();
	for (const model of models) {
		let group = groups.get(model.model.provider);
		if (!group) {
			group = [];
			groups.set(model.model.provider, group);
		}
		group.push(model);
	}
	for (const placeholder of placeholders) {
		if (!groups.has(placeholder.vendor)) { groups.set(placeholder.vendor, []); }
	}
	if (groups.size === 0) {
		return [{ id: '', label: localize('chat.modelPicker.models', 'Models'), models: [], placeholders: [] }];
	}
	return [...groups].map(([id, entries]) => ({
		id,
		label: providerLabels[id] ?? labels.get(id) ?? placeholders.find(placeholder => placeholder.vendor === id)?.label ?? id,
		models: entries,
		placeholders: entries.length ? [] : placeholders.filter(placeholder => placeholder.vendor === id),
	}));
}
