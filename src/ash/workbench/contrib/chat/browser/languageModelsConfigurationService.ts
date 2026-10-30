import type { ModelRef } from '../../../services/chat/common/chatService.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { TaskQueue } from '../../../../base/common/async.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import { modelRefIdentity } from '../../../services/chat/common/modelCatalog.js';
import { ModelCatalogConfiguration, isModelVisibleByDefault, type ModelVisibilityPreference } from '../common/languageModelsConfiguration.js';
import type { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';

export const ChatModelPreferences = Object.freeze({ selectedModelStorageKey: 'chat.currentLanguageModel.chat' });

export class LanguageModelsConfigurationService extends Disposable implements ILanguageModelsConfigurationService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeModels = this.changed.event;
	private readonly modelVisibility = new Map<string, ModelVisibilityPreference>();
	private readonly visibilityUpdates = new TaskQueue();
	constructor(private readonly preferences: { readonly selectedModelStorageKey: string; }, @IConfigurationService private readonly configuration: IConfigurationService, @IStorageService private readonly storage: IStorageService) {
		super();
		this._register(toDisposable(() => this.visibilityUpdates.clearPending()));
		this.acceptHiddenModels(configuration.getValue(ModelCatalogConfiguration.hiddenModels));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === this.preferences.selectedModelStorageKey) { this.changed.fire(); }
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ModelCatalogConfiguration.hiddenModels)) { this.acceptHiddenModels(configuration.getValue(ModelCatalogConfiguration.hiddenModels)); }
		}));
	}
	public getDefaultNewChatModel(models: readonly ModelCatalogEntry[], savedModel?: ModelRef | null): ModelRef | undefined {
		const remembered = this.storage.get(this.preferences.selectedModelStorageKey, StorageScope.PROFILE);
		// Manual picker choices are saved in the backend; the UI profile only overrides that choice with Auto.
		if (remembered?.toLowerCase() === 'auto') { return undefined; }
		if (savedModel !== undefined) { return savedModel ?? undefined; }
		if (!remembered) { return undefined; }
		const match = models.find(entry => `${entry.model.provider}/${entry.model.model}`.toLowerCase() === remembered.toLowerCase());
		if (match) { return match.model; }
		const unqualified = models.filter(entry => entry.model.model.toLowerCase() === remembered.toLowerCase());
		return unqualified.length === 1 ? unqualified[0].model : undefined;
	}

	public rememberSelectedModel(model: ModelRef | undefined | null): void {
		if (model === null) { this.storage.remove(this.preferences.selectedModelStorageKey, StorageScope.PROFILE); return; }
		const value = model ? `${model.provider}/${model.model}` : 'auto';
		this.storage.store(this.preferences.selectedModelStorageKey, value, StorageScope.PROFILE, StorageTarget.USER);
	}

	public isModelVisible(model: ModelRef): boolean {
		const preference = this.modelVisibility.get(modelRefIdentity(model));
		return preference ? preference.visible === true : isModelVisibleByDefault(model);
	}

	public setModelVisible(model: ModelRef, visible: boolean): Promise<void> {
		return this.visibilityUpdates.schedule(async () => {
			// Recompute after the previous durable write: separate switches share one setting.
			const identity = modelRefIdentity(model);
			if (visible === this.isModelVisible(model)) { return; }
			const models = [...this.modelVisibility.values()].filter(candidate => modelRefIdentity(candidate) !== identity);
			if (visible !== isModelVisibleByDefault(model)) { models.push(visible ? { ...model, visible: true } : { ...model }); }
			await this.configuration.updateValue(ModelCatalogConfiguration.hiddenModels, models);
		});
	}

	public removeProviderPreferences(connection: string): Promise<void> {
		return this.visibilityUpdates.schedule(async () => {
			const models = this.configuration.getValue<readonly ModelVisibilityPreference[]>(ModelCatalogConfiguration.hiddenModels);
			const retained = models.filter(model => model.provider !== connection);
			if (retained.length !== models.length) { await this.configuration.updateValue(ModelCatalogConfiguration.hiddenModels, retained); }
		});
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
