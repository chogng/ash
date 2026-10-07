import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { CustomModelProvider, ModelProviderTestResult } from '../../../../platform/sessions/common/sessionApi.js';
import type { ModelPreferencesUpdate } from '../../../../platform/sessions/common/sessionApi.js';
import type { ApprovalReviewModelSelection } from '../../../../platform/sessions/common/sessionApi.js';
import type { ModelRef, ModelProviderCredentialStatus } from '../../../../workbench/services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';

export const CoworkModelPreferences = Object.freeze({
	defaultModelSetting: Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string>({
		key: 'cowork.defaultmodel',
		defaultValue: '',
		parse(value: unknown): string {
			if (typeof value !== 'string') { throw new TypeError(localize('cowork.defaultmodel.invalid', 'Default Cowork model must be a string.')); }
			return value.trim();
		},
		setting: {
			get title() { return localize('cowork.defaultmodel.title', 'Default Cowork model'); },
			get description() { return localize('cowork.defaultmodel.description', 'The model for new Cowork conversations. Enter auto or a provider/model ID.'); },
			valueType: 'text',
			get placeholder() { return localize('cowork.defaultmodel.placeholder', 'auto or provider/model'); },
		},
	}),
	selectedModelStorageKey: 'cowork.currentLanguageModel',
});

/** Model catalog, provider credentials and picker preferences shared by both windows. */
export interface ILanguageModelsService {
	readApprovalReviewModel(): Promise<ApprovalReviewModelSelection>;
	setApprovalReviewModel(selection: ApprovalReviewModelSelection): Promise<void>;
	setModelPreferences(model: ModelRef, update: ModelPreferencesUpdate): Promise<void>;
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

