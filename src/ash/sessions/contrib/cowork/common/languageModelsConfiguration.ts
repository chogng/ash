import type { Event } from '../../../../base/common/event.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ModelRef } from '../../../../workbench/services/chat/common/chatService.js';

export interface ILanguageModelsConfigurationService {
	readonly onDidChangeModels: Event<void>;
	getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined;
	rememberSelectedModel(model: ModelRef | undefined): void;
	isModelVisible(model: ModelRef): boolean;
	setModelVisible(model: ModelRef, visible: boolean): Promise<void>;
}
export const ILanguageModelsConfigurationService = createServiceIdentifier<ILanguageModelsConfigurationService>('coworkLanguageModelsConfigurationService');
