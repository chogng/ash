import { isRecord } from '../../../../base/common/types.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import type { ModelRef } from './chatService.js';

export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'extraHigh' | 'max';

const MaximumHiddenModels = 2_048;
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);


export interface ModelCatalogEntry {
	readonly model: ModelRef;
	readonly displayName: string;
	readonly contextWindow?: number | null;
	readonly supportedReasoningEfforts?: readonly ModelReasoningEffort[];
	readonly modelReasoningEffort?: ModelReasoningEffort;
}

/** User-owned presentation preferences for the shared model catalog. */
export const ModelCatalogConfiguration = Object.freeze({
	defaultModel: configurationRegistry.registerConfiguration<string>({
		key: 'chat.defaultModel',
		defaultValue: '',
		parse(value: unknown): string {
			if (typeof value !== 'string') throw new TypeError('Default chat model must be a string');
			return value.trim();
		},
		setting: {
			title: localize('chat.defaultModel.title', 'Default chat model'),
			description: localize('chat.defaultModel.description', 'The model for new chats. Use auto for automatic selection, or enter a provider/model ID. You can still change the model within a chat.'),
			valueType: 'text',
			placeholder: localize('chat.defaultModel.placeholder', 'auto or provider/model'),
		},
	}),
	hiddenModels: configurationRegistry.registerConfiguration<readonly ModelRef[]>({
		key: 'models.hidden',
		defaultValue: Object.freeze([]),
		parse: parseHiddenModels,
		serialize: models => models.map(model => ({ provider: model.provider, model: model.model })),
	}),
});

export function modelRefIdentity(model: ModelRef): string {
	return `${model.provider}\0${model.model}`;
}

function parseHiddenModels(value: unknown): readonly ModelRef[] {
	if (!Array.isArray(value)) throw new TypeError('Hidden models must be an array');
	if (value.length > MaximumHiddenModels) throw new RangeError(`Hidden models must contain at most ${MaximumHiddenModels} entries`);
	const models = new Map<string, ModelRef>();
	for (const candidate of value) {
		if (!isRecord(candidate)) throw new TypeError('Hidden model entries must be objects');
		const provider = modelIdentifier(candidate.provider, 'provider');
		const model = modelIdentifier(candidate.model, 'model');
		const reference = Object.freeze({ provider, model });
		models.set(modelRefIdentity(reference), reference);
	}
	return Object.freeze([...models.values()].sort(compareModelRefs));
}

function modelIdentifier(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`Model ${label} must not be empty`);
	return value;
}

function compareModelRefs(left: ModelRef, right: ModelRef): number {
	if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
	if (left.model === right.model) return 0;
	return left.model < right.model ? -1 : 1;
}
