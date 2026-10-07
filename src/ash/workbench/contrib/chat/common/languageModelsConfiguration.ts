import type { Event } from '../../../../base/common/event.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { isRecord } from '../../../../base/common/types.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import type { ModelRef } from '../../../services/chat/common/chatService.js';

const MaximumHiddenModels = 2_048;
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

const DefaultVisibleModels = new Set([
	'openai\0gpt-6.1-sol',
	'openai\0gpt-6-astra',
	'openai\0gpt-6-luna',
	'anthropic\0claude-opus-5-5',
	'anthropic\0claude-sonnet-5-5',
	'xai\0grok-4.7',
]);

/** Existing models.hidden entries remain explicit exclusions; visible enables a model over the product default. */
export interface ModelVisibilityPreference extends ModelRef {
	readonly visible?: boolean;
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
	hiddenModels: configurationRegistry.registerConfiguration<readonly ModelVisibilityPreference[]>({
		key: 'models.hidden',
		defaultValue: Object.freeze([]),
		parse: parseHiddenModels,
		serialize: models => models.map(model => model.visible
			? { provider: model.provider, model: model.model, visible: true }
			: { provider: model.provider, model: model.model }),
	}),
});

export function isModelVisibleByDefault(model: ModelRef): boolean {
	return DefaultVisibleModels.has(modelRefIdentity(model));
}

function parseHiddenModels(value: unknown): readonly ModelVisibilityPreference[] {
	if (!Array.isArray(value)) throw new TypeError('Hidden models must be an array');
	if (value.length > MaximumHiddenModels) throw new RangeError(`Hidden models must contain at most ${MaximumHiddenModels} entries`);
	const models = new Map<string, ModelVisibilityPreference>();
	for (const candidate of value) {
		if (!isRecord(candidate)) throw new TypeError('Hidden model entries must be objects');
		const provider = modelIdentifier(candidate.provider, 'provider');
		const model = modelIdentifier(candidate.model, 'model');
		if (candidate.visible !== undefined && typeof candidate.visible !== 'boolean') throw new TypeError('Model visibility must be a boolean');
		const reference = Object.freeze(candidate.visible === true ? { provider, model, visible: true } : { provider, model });
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

export interface ILanguageModelsConfigurationService {
	readonly onDidChangeModels: Event<void>;
	getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined;
	rememberSelectedModel(model: ModelRef | undefined): void;
	isModelVisible(model: ModelRef): boolean;
	setModelVisible(model: ModelRef, visible: boolean): Promise<void>;
}
export const ILanguageModelsConfigurationService = createServiceIdentifier<ILanguageModelsConfigurationService>('languageModelsConfigurationService');
