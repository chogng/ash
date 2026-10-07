import type { ModelListResult } from '../../../../../../crates/app-server-protocol/schema/typescript/index.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IModelApi, type CustomModelProvider, type ModelProviderTestResult } from '../../../../platform/sessions/common/sessionApi.js';
import type { ModelPreferencesUpdate } from '../../../../platform/sessions/common/sessionApi.js';
import type { ApprovalReviewModelSelection } from '../../../../platform/sessions/common/sessionApi.js';
import { IAppServerApi, IServerEventApi } from '../../../../platform/app-server/common/appServerApi.js';
import { ILanguageModelsConfigurationService } from './languageModelsConfiguration.js';
import type { ModelRef, ModelProviderCredentialStatus } from '../../../services/chat/common/chatService.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';

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

export class LanguageModelsService extends Disposable implements ILanguageModelsService {
	public readApprovalReviewModel(): Promise<ApprovalReviewModelSelection> { return this.modelApi.readApprovalReviewModel(); }
	public async setApprovalReviewModel(selection: ApprovalReviewModelSelection): Promise<void> {
		await this.modelApi.setApprovalReviewModel(selection);
		this.changed.fire();
	}
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
			if (state === 'ready') { void this.refreshModels().catch(() => { }); }
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
		return models.map(modelCatalogEntry);
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
		const [catalog, providers] = await Promise.all([this.modelApi.listModels(), this.modelApi.listProviders()]);
		const models: Parameters<typeof this.acceptModelCatalog>[0][number][] = [...catalog.models];
		for (const connection of ['kimi-desktop', 'kimi-cli']) {
			if (!providers.providers.some(provider => provider.connection === connection && provider.ready)) { continue; }
			models.push(...await this.modelApi.listProviderModels(connection));
		}
		return this.acceptModelCatalog(models);
	}

	private acceptModelCatalog(entries: Readonly<ModelListResult['models']>): readonly ModelCatalogEntry[] {
		const identities = new Set<string>();
		const catalog = entries.map(entry => {
			const identity = modelRefIdentity(entry.model);
			if (identities.has(identity)) { throw new Error(`Model catalog contains duplicate entry '${entry.model.provider}/${entry.model.model}'`); }
			identities.add(identity);
			return modelCatalogEntry(entry);
		});
		const changed = !sameModelCatalog(this.modelCatalog, catalog);
		this.modelCatalog = Object.freeze(catalog);
		this.hasLoadedModelCatalog = true;
		if (changed) { this.changed.fire(); }
		return this.modelCatalog;
	}
}

function modelCatalogEntry(entry: ModelListResult['models'][number]): ModelCatalogEntry {
	return Object.freeze({
		model: Object.freeze({ ...entry.model }),
		displayName: entry.display_name,
		retirement: entry.retirement ? Object.freeze({ shutdownDate: entry.retirement.shutdown_date }) : undefined,
		description: entry.description,
		defaultContextWindow: entry.default_context_window,
		maximumContextWindow: entry.maximum_context_window,
		accelerationOptions: Object.freeze(entry.acceleration_options.map(option => Object.freeze({ ...option }))),
		selectedAcceleration: entry.selected_acceleration,
		longContext: entry.long_context,
		...(entry.discovered === true ? { discovered: true } : {}),
		contextWindow: entry.context_window,
		supportedReasoningEfforts: Object.freeze(entry.supported_reasoning_efforts.map(option => Object.freeze({ ...option }))),
		...(entry.default_reasoning_effort != null ? { defaultReasoningEffort: entry.default_reasoning_effort } : {}),
	});
}

function sameModelCatalog(left: readonly ModelCatalogEntry[], right: readonly ModelCatalogEntry[]): boolean {
	return left.length === right.length && left.every((entry, index) => {
		const candidate = right[index];
		return candidate !== undefined
			&& entry.displayName === candidate.displayName
			&& entry.description === candidate.description
			&& entry.discovered === candidate.discovered
			// Announcement withdrawal and date changes must notify open pickers, even with identical models.
			&& (entry.retirement !== undefined) === (candidate.retirement !== undefined)
			&& entry.retirement?.shutdownDate === candidate.retirement?.shutdownDate
			&& modelRefIdentity(entry.model) === modelRefIdentity(candidate.model)
			&& entry.contextWindow === candidate.contextWindow
			&& entry.defaultContextWindow === candidate.defaultContextWindow
			&& entry.maximumContextWindow === candidate.maximumContextWindow
			&& entry.selectedAcceleration === candidate.selectedAcceleration
			&& entry.accelerationOptions?.length === candidate.accelerationOptions?.length
			&& (entry.accelerationOptions?.every((option, index) => option.id === candidate.accelerationOptions?.[index]?.id && option.name === candidate.accelerationOptions?.[index]?.name && option.description === candidate.accelerationOptions?.[index]?.description) ?? true)
			&& entry.longContext === candidate.longContext
			&& entry.defaultReasoningEffort === candidate.defaultReasoningEffort
			&& entry.supportedReasoningEfforts?.length === candidate.supportedReasoningEfforts?.length
			&& (entry.supportedReasoningEfforts?.every((option, index) => option.effort === candidate.supportedReasoningEfforts?.[index]?.effort && option.description === candidate.supportedReasoningEfforts?.[index]?.description) ?? true);
	});
}
