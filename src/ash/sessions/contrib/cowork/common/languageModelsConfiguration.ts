import type { Event } from '../../../../base/common/event.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ModelRef } from '../../../../workbench/services/chat/common/chatService.js';

// Model visibility is a shared catalog setting; its schema is registered once by window composition.
export const ModelCatalogConfiguration = Object.freeze({ hiddenModels: 'models.hidden' });

const DefaultVisibleModels = new Set([
	'openai\0gpt-6.1-sol',
	'openai\0gpt-6-astra',
	'openai\0gpt-6-luna',
	'anthropic\0claude-opus-5-5',
	'anthropic\0claude-sonnet-5-5',
	'xai\0grok-4.7',
]);

export interface ModelVisibilityPreference extends ModelRef {
	readonly visible?: boolean;
}

export function isModelVisibleByDefault(model: ModelRef): boolean {
	return DefaultVisibleModels.has(modelRefIdentity(model));
}

export interface ILanguageModelsConfigurationService {
	readonly onDidChangeModels: Event<void>;
	getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined;
	rememberSelectedModel(model: ModelRef | undefined): void;
	isModelVisible(model: ModelRef): boolean;
	setModelVisible(model: ModelRef, visible: boolean): Promise<void>;
}
export const ILanguageModelsConfigurationService = createServiceIdentifier<ILanguageModelsConfigurationService>('coworkLanguageModelsConfigurationService');
