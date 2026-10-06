import type { ModelRef } from '../../../services/chat/common/chatService.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import { modelRefIdentity } from '../../../services/chat/common/modelCatalog.js';
import { ModelCatalogConfiguration, isModelVisibleByDefault, type ModelVisibilityPreference } from '../common/languageModelsConfiguration.js';
import type { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';

export const ChatModelPreferences = Object.freeze({ defaultModelSetting: ModelCatalogConfiguration.defaultModel, selectedModelStorageKey: 'chat.currentLanguageModel.chat' });

export class LanguageModelsConfigurationService extends Disposable implements ILanguageModelsConfigurationService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeModels = this.changed.event;
	private readonly modelVisibility = new Map<string, ModelVisibilityPreference>();
	constructor(private readonly preferences: { readonly defaultModelSetting: string; readonly selectedModelStorageKey: string }, @IConfigurationService private readonly configuration: IConfigurationService, @IStorageService private readonly storage: IStorageService) {
		super();
		this.acceptHiddenModels(configuration.getValue(ModelCatalogConfiguration.hiddenModels));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === this.preferences.selectedModelStorageKey) { this.changed.fire(); }
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ModelCatalogConfiguration.hiddenModels)) { this.acceptHiddenModels(configuration.getValue(ModelCatalogConfiguration.hiddenModels)); }
			if (event.affectsConfiguration(this.preferences.defaultModelSetting)) { this.changed.fire(); }
		}));
	}
	public getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined {
		const configured = this.configuration.getValue<string>(this.preferences.defaultModelSetting).trim();
		const remembered = this.storage.get(this.preferences.selectedModelStorageKey, StorageScope.PROFILE);
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
		this.storage.store(this.preferences.selectedModelStorageKey, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	public isModelVisible(model: ModelRef): boolean {
		const preference = this.modelVisibility.get(modelRefIdentity(model));
		return preference ? preference.visible === true : isModelVisibleByDefault(model);
	}

	public async setModelVisible(model: ModelRef, visible: boolean): Promise<void> {
		const identity = modelRefIdentity(model);
		if (visible === this.isModelVisible(model)) { return; }
		const models = [...this.modelVisibility.values()].filter(candidate => modelRefIdentity(candidate) !== identity);
		if (visible !== isModelVisibleByDefault(model)) { models.push(visible ? { ...model, visible: true } : { ...model }); }
		await this.configuration.updateValue(ModelCatalogConfiguration.hiddenModels, models);
	}

	private acceptHiddenModels(models: readonly ModelVisibilityPreference[]): void {
		const next = new Map(models.map(model => [modelRefIdentity(model), Object.freeze({ ...model })]));
		if (sameVisibility(this.modelVisibility, next)) { return; }
		this.modelVisibility.clear();
		for (const [identity, model] of next) { this.modelVisibility.set(identity, model); }
		this.changed.fire();
	}
}

function sameVisibility(left: ReadonlyMap<string, ModelVisibilityPreference>, right: ReadonlyMap<string, ModelVisibilityPreference>): boolean {
	return left.size === right.size && [...left].every(([key, model]) => right.has(key) && right.get(key)!.visible === model.visible);
}

