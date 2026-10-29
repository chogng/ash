import type { ModelRef } from '../../../../workbench/services/chat/common/chatService.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import type { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';

export class LanguageModelsConfigurationService extends Disposable implements ILanguageModelsConfigurationService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeModels = this.changed.event;
	constructor(
		private readonly preferences: {
			readonly defaultModelSetting: string;
			readonly selectedModelStorageKey: string;
		},
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@ILanguageModelsService private readonly models: ILanguageModelsService,
	) {
		super();
		// Catalog visibility and its durable writes belong to the shared model service.
		this._register(models.onDidChangeModels(() => this.changed.fire()));
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === this.preferences.selectedModelStorageKey) {
					this.changed.fire();
				}
			}),
		);
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(this.preferences.defaultModelSetting)) {
					this.changed.fire();
				}
			}),
		);
	}
	public getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined {
		const configured = this.configuration.getValue<string>(this.preferences.defaultModelSetting).trim();
		const remembered = this.storage.get(this.preferences.selectedModelStorageKey, StorageScope.PROFILE);
		for (const requested of [configured, remembered]) {
			if (!requested) {
				continue;
			}
			if (requested.toLowerCase() === 'auto') {
				return undefined;
			}
			const match = models.find(entry => `${entry.model.provider}/${entry.model.model}`.toLowerCase() === requested.toLowerCase());
			if (match) {
				return match.model;
			}
			const unqualified = models.filter(entry => entry.model.model.toLowerCase() === requested.toLowerCase());
			if (unqualified.length === 1) {
				return unqualified[0].model;
			}
		}
		return undefined;
	}

	public rememberSelectedModel(model: ModelRef | undefined): void {
		const value = model ? `${model.provider}/${model.model}` : 'auto';
		this.storage.store(this.preferences.selectedModelStorageKey, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	public isModelVisible(model: ModelRef): boolean {
		return this.models.isModelVisible(model);
	}

	public setModelVisible(model: ModelRef, visible: boolean): Promise<void> {
		return this.models.setModelVisible(model, visible);
	}
}
