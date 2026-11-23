import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Extensions as WorkbenchExtensions, type IConfigurationMigrationRegistry } from '../../../../workbench/common/configuration.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import type { ModelRef } from '../../../../workbench/services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';

export const NativeChatModelPreferences = Object.freeze({
	defaultModelSetting: Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string>({
		key: 'sessions.chat.defaultModel',
		defaultValue: '',
		parse(value: unknown): string {
			if (typeof value !== 'string') { throw new TypeError(localize('sessions.chat.defaultModel.invalid', 'Default Chat model must be a string.')); }
			return value.trim();
		},
		setting: {
			get title() { return localize('sessions.chat.defaultModel.title', 'Default Chat model'); },
			get description() { return localize('sessions.chat.defaultModel.description', 'The model for new Ash Chat conversations. Enter auto or a provider/model ID.'); },
			valueType: 'text',
			get placeholder() { return localize('sessions.chat.defaultModel.placeholder', 'auto or provider/model'); },
		},
	}),
	selectedModelStorageKey: 'sessions.chat.currentLanguageModel',
});

Registry.as<IConfigurationMigrationRegistry>(WorkbenchExtensions.ConfigurationMigration).registerConfigurationMigrations([{
	key: 'cowork.defaultmodel',
	migrateFn(value, read) {
		if (read(NativeChatModelPreferences.defaultModelSetting) !== undefined) return { value: undefined };
		if (typeof value !== 'string') return { value };
		return [
			[NativeChatModelPreferences.defaultModelSetting, { value: value.trim() }],
			['cowork.defaultmodel', { value: undefined }],
		];
	},
}]);

export interface INativeChatModelPreferencesService {
	readonly onDidChangeModels: Event<void>;
	getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined;
	rememberSelectedModel(model: ModelRef | undefined): void;
	isModelVisible(model: ModelRef): boolean;
	setModelVisible(model: ModelRef, visible: boolean): Promise<void>;
}

export const INativeChatModelPreferencesService = createServiceIdentifier<INativeChatModelPreferencesService>('nativeChatModelPreferencesService');

export class NativeChatModelPreferencesService extends Disposable implements INativeChatModelPreferencesService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeModels = this.changed.event;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@ILanguageModelsService private readonly models: ILanguageModelsService,
	) {
		super();
		const legacyKey = 'cowork.currentLanguageModel';
		const legacyModel = storage.get(legacyKey, StorageScope.PROFILE);
		if (legacyModel !== undefined) {
			if (storage.get(NativeChatModelPreferences.selectedModelStorageKey, StorageScope.PROFILE) === undefined) {
				storage.store(NativeChatModelPreferences.selectedModelStorageKey, legacyModel, StorageScope.PROFILE, StorageTarget.USER);
			}
			storage.remove(legacyKey, StorageScope.PROFILE);
		}
		// Catalog visibility and its durable writes belong to the shared model service.
		this._register(models.onDidChangeModels(() => this.changed.fire()));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === NativeChatModelPreferences.selectedModelStorageKey) { this.changed.fire(); }
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(NativeChatModelPreferences.defaultModelSetting)) { this.changed.fire(); }
		}));
	}

	public getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined {
		const configured = this.configuration.getValue<string>(NativeChatModelPreferences.defaultModelSetting).trim();
		const remembered = this.storage.get(NativeChatModelPreferences.selectedModelStorageKey, StorageScope.PROFILE);
		for (const requested of [configured, remembered]) {
			if (!requested) { continue; }
			if (requested.toLowerCase() === 'auto') { return undefined; }
			const match = models.find(entry => `${entry.model.provider}/${entry.model.model}`.toLowerCase() === requested.toLowerCase());
			if (match) { return match.model; }
			const unqualified = models.filter(entry => entry.model.model.toLowerCase() === requested.toLowerCase());
			if (unqualified.length === 1) { return unqualified[0].model; }
		}
		return undefined;
	}

	public rememberSelectedModel(model: ModelRef | undefined): void {
		const value = model ? `${model.provider}/${model.model}` : 'auto';
		this.storage.store(NativeChatModelPreferences.selectedModelStorageKey, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	public isModelVisible(model: ModelRef): boolean {
		return this.models.isModelVisible(model);
	}

	public setModelVisible(model: ModelRef, visible: boolean): Promise<void> {
		return this.models.setModelVisible(model, visible);
	}
}
