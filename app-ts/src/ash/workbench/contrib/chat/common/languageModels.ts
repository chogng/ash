import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IModelApi, type CustomModelProvider, type ModelProviderTestResult } from '../../../../platform/sessions/common/sessionApi.js';
import type { ModelPreferencesUpdate } from '../../../../platform/sessions/common/sessionApi.js';
import { IAppServerApi, IServerEventApi } from '../../../../platform/app-server/common/appServerApi.js';
import { ILanguageModelsConfigurationService } from './languageModelsConfiguration.js';
import type { ModelRef, ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';

/** Model catalog, provider credentials and picker preferences shared by both windows. */
export interface ILanguageModelsService {
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

export class LanguageModelsService extends Disposable implements ILanguageModelsService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeModels = this.changed.event;
	private modelCatalog: readonly ModelCatalogEntry[] = [];
	private modelCatalogLoad: Promise<readonly ModelCatalogEntry[]> | undefined;
	private hasLoadedModelCatalog = false;
	constructor(@IModelApi private readonly modelApi: IModelApi,
		@IAppServerApi appServer: IAppServerApi, @IServerEventApi events: IServerEventApi,
		@ILanguageModelsConfigurationService private readonly preferences: ILanguageModelsConfigurationService) {
		super();
		this._register(preferences.onDidChangeModels(() => this.changed.fire()));
		const subscription = events.subscribe(event => {
			if (event.method === 'provider/apiKey/changed') { this.changed.fire(); }
		});
		this._register(toDisposable(() => subscription.dispose()));
		const connection = appServer.onConnectionState(state => {
			if (state === 'ready') { void this.refreshModels().catch(() => {}); }
		});
		this._register(toDisposable(() => connection.dispose()));
	}
	public getDefaultNewChatModel(models: readonly ModelCatalogEntry[]): ModelRef | undefined { return this.preferences.getDefaultNewChatModel(models); }
	public rememberSelectedModel(model: ModelRef | undefined): void { this.preferences.rememberSelectedModel(model); }
	public isModelVisible(model: ModelRef): boolean { return this.preferences.isModelVisible(model); }
	public setModelVisible(model: ModelRef, visible: boolean): Promise<void> { return this.preferences.setModelVisible(model, visible); }
	public async discoverProviderModels(connection: string): Promise<readonly ModelCatalogEntry[]> {
		// An older catalog request may predate the completed endpoint observation.
		const models = await this.modelApi.listProviderModels(connection);
		if (this.modelCatalogLoad) { await this.modelCatalogLoad; }
		await this.refreshModels();
		return models;
	}
	public async listModels(): Promise<readonly ModelCatalogEntry[]> {
		const catalog = await this.listModelCatalog();
		return catalog.filter(entry => this.isModelVisible(entry.model));
	}

	public async listModelCatalog(): Promise<readonly ModelCatalogEntry[]> {
		if (this.hasLoadedModelCatalog) { return this.modelCatalog; }
		return this.refreshModels();
	}

	public async listCustomModelProviders(): Promise<readonly CustomModelProvider[]> {
		return this.modelApi.listCustomProviders();
	}

	public async saveCustomModelProvider(provider: CustomModelProvider): Promise<void> {
		await this.modelApi.saveCustomProvider(provider);
	}

	public async setModelPreferences(model: ModelRef, update: ModelPreferencesUpdate): Promise<void> {
		await this.modelApi.setModelPreferences(model, update);
		// A catalog request started before the save cannot report the new preferences.
		if (this.modelCatalogLoad) { await this.modelCatalogLoad; }
		await this.refreshModels();
	}

	public async testProviderModel(provider: CustomModelProvider, model: string): Promise<ModelProviderTestResult> {
		return this.modelApi.testProviderModel(provider, model);
	}

	public async listModelProviders(): Promise<readonly ModelProviderCredentialStatus[]> {
		const result = await this.modelApi.listProviders();
		return result.providers.map(provider => ({
			provider: provider.provider,
			connection: provider.connection,
			access: provider.access,
			active: provider.active,
			configured: provider.configured,
			ready: provider.ready,
			displayName: provider.displayName,
			apiKeyPolicy: provider.apiKeyPolicy,
			apiKeyConfigured: provider.apiKeyConfigured,
		}));
	}

	public async setModelProviderApiKey(connection: string, apiKey: string): Promise<void> {
		await this.modelApi.setProviderApiKey({ connection, apiKey });
	}
	public async removeModelProviderApiKey(connection: string): Promise<void> {
		await this.modelApi.removeProviderApiKey(connection);
	}

	public async listAdvisorModels(): Promise<readonly ModelCatalogEntry[]> {
		return this.listModelCatalog();
	}

	public async refreshModels(): Promise<readonly ModelCatalogEntry[]> {
		if (this.modelCatalogLoad) { return this.modelCatalogLoad; }
		const load = this.loadModelCatalog();
		this.modelCatalogLoad = load;
		try {
			return await load;
		} finally {
			if (this.modelCatalogLoad === load) { this.modelCatalogLoad = undefined; }
		}
	}

	private async loadModelCatalog(): Promise<readonly ModelCatalogEntry[]> {
		const [catalog, providers, fastModels] = await Promise.all([this.modelApi.listModels(), this.modelApi.listProviders(), this.modelApi.listFastModels()]);
		const models: Parameters<typeof this.acceptModelCatalog>[0][number][] = [...catalog.models];
		for (const connection of ['kimi-desktop', 'kimi-cli']) {
			if (!providers.providers.some(provider => provider.connection === connection && provider.ready)) { continue; }
			models.push(...await this.modelApi.listProviderModels(connection));
		}
		return this.acceptModelCatalog(models, new Set(fastModels.map(modelRefIdentity)));
	}

	private acceptModelCatalog(entries: readonly {
		readonly model: ModelRef;
		readonly displayName: string;
		readonly discovered?: boolean | null;
		readonly contextWindow?: number | null;
		readonly maximumContextWindow?: number | null;
		readonly capabilities?: { readonly fastMode: string };
		readonly supportedReasoningEfforts?: ModelCatalogEntry['supportedReasoningEfforts'];
		readonly modelReasoningEffort?: ModelCatalogEntry['modelReasoningEffort'] | null;
	}[], fastModels: ReadonlySet<string>): readonly ModelCatalogEntry[] {
		const identities = new Set<string>();
		const catalog = entries.map(entry => {
			const identity = modelRefIdentity(entry.model);
			if (identities.has(identity)) { throw new Error(`Model catalog contains duplicate entry '${entry.model.provider}/${entry.model.model}'`); }
			identities.add(identity);
			return Object.freeze({
				model: Object.freeze({ ...entry.model }),
				displayName: entry.displayName,
				maximumContextWindow: entry.maximumContextWindow,
				supportsFast: entry.capabilities?.fastMode === 'supported',
				fast: fastModels.has(identity),
				...(entry.discovered === true ? { discovered: true } : {}),
				...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
				...(entry.supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts: Object.freeze([...entry.supportedReasoningEfforts]) } : {}),
				...(entry.modelReasoningEffort != null ? { modelReasoningEffort: entry.modelReasoningEffort } : {}),
			});
		});
		const changed = !sameModelCatalog(this.modelCatalog, catalog);
		this.modelCatalog = Object.freeze(catalog);
		this.hasLoadedModelCatalog = true;
		if (changed) { this.changed.fire(); }
		return this.modelCatalog;
	}
}

function sameModelCatalog(left: readonly ModelCatalogEntry[], right: readonly ModelCatalogEntry[]): boolean {
	return left.length === right.length && left.every((entry, index) => {
		const candidate = right[index];
		return candidate !== undefined
			&& entry.displayName === candidate.displayName
			&& entry.discovered === candidate.discovered
			&& modelRefIdentity(entry.model) === modelRefIdentity(candidate.model)
			&& entry.contextWindow === candidate.contextWindow
			&& entry.maximumContextWindow === candidate.maximumContextWindow
			&& entry.supportsFast === candidate.supportsFast
			&& entry.fast === candidate.fast
			&& entry.modelReasoningEffort === candidate.modelReasoningEffort
			&& entry.supportedReasoningEfforts?.join('\0') === candidate.supportedReasoningEfforts?.join('\0');
	});
}
