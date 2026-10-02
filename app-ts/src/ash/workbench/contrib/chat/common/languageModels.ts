import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { CustomModelProvider, ModelProviderTestResult } from '../../../../platform/sessions/common/sessionApi.js';
import type { ModelRef, ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';

/** Model catalog, provider credentials and picker preferences shared by both windows. */
export interface ILanguageModelsService {
	readonly onDidChangeModels: Event<void>;
	listModels(): Promise<readonly ModelCatalogEntry[]>;
	getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined;
	rememberSelectedModel(model: ModelRef | undefined): void;
	listModelCatalog(): Promise<readonly ModelCatalogEntry[]>;
	listCustomModelProviders(): Promise<readonly CustomModelProvider[]>;
	saveCustomModelProvider(provider: CustomModelProvider): Promise<void>;
	testProviderModel(provider: CustomModelProvider, model: string): Promise<ModelProviderTestResult>;
	listModelProviders(): Promise<readonly ModelProviderCredentialStatus[]>;
	setModelProviderApiKey(connection: string, apiKey: string): Promise<void>;
	removeModelProviderApiKey(connection: string): Promise<void>;
	listAdvisorModels(): Promise<readonly ModelCatalogEntry[]>;
	refreshModels(): Promise<readonly ModelCatalogEntry[]>;
	isModelVisible(model: ModelRef): boolean;
	setModelVisible(model: ModelRef, visible: boolean): Promise<void>;
	discoverProviderModels(connection: string): Promise<readonly ModelCatalogEntry[]>;
}

export const ILanguageModelsService = createServiceIdentifier<ILanguageModelsService>('languageModelsService');
