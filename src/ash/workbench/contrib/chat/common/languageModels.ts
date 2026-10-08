import type { ModelListResult, ProviderListResult } from '../../../../../../.build/protocol/typescript/index.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { canceled } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IModelApi, type CustomModelProvider, type ModelProviderTestResult } from '../../../../platform/sessions/common/sessionApi.js';
import type { ModelPreferencesUpdate } from '../../../../platform/sessions/common/sessionApi.js';
import type { ApprovalReviewModelSelection } from '../../../../platform/sessions/common/sessionApi.js';
import { IAppServerApi, IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { IAccountService, type AccountState } from '../../../../platform/accounts/common/accountService.js';
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
	private modelCatalogLoad: Promise<void> | undefined;
	private hasLoadedModelCatalog = false;
	private catalogRevision = 0;
	private catalogGeneration = 0;
	private catalogAttemptRevision = 0;
	private accountScope: string | undefined;
	private accountState: AccountState | undefined;
	private modelAccountConnections: ReadonlySet<string> | undefined;
	private providerState = '[]';
	constructor(@IModelApi private readonly modelApi: IModelApi,
		@IAppServerApi private readonly appServer: IAppServerApi, @IServerEventApi events: IServerEventApi,
		@ILanguageModelsConfigurationService private readonly preferences: ILanguageModelsConfigurationService,
		@IAccountService private readonly accounts: IAccountService) {
		super();
		this._register(preferences.onDidChangeModels(() => this.changed.fire()));
		const subscription = events.subscribe(event => {
			if (event.method === 'provider/models/updated') {
				// The tagged outcome describes one provider observation, not the global catalog.
				this.invalidateModelCatalog();
			} else if (event.method === 'provider/apiKey/changed') {
				this.retireModelCatalog(true);
				this.invalidateModelCatalog();
			}
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(accounts.onDidChangeAccounts(state => {
			this.accountState = state;
			const scope = accountCatalogScope(state, this.modelAccountConnections);
			if (scope !== this.accountScope) {
				this.accountScope = scope;
				this.retireModelCatalog();
			}
			this.invalidateModelCatalog();
		}));
		const connection = appServer.onConnectionState(state => {
			this.accountScope = undefined;
			this.accountState = undefined;
			this.modelAccountConnections = undefined;
			this.retireModelCatalog();
			if (state === 'ready') { this.invalidateModelCatalog(); }
		});
		this._register(toDisposable(() => connection.dispose()));
		this._register(toDisposable(() => this.retireModelCatalog()));
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
		return modelProviderStatuses(result);
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
		this.assertNotDisposed();
		const load = this.modelCatalogLoad ?? this.loadModelCatalog(++this.catalogGeneration, this.appServer.connectionGeneration);
		this.modelCatalogLoad = load;
		const generation = this.catalogGeneration;
		const connectionGeneration = this.appServer.connectionGeneration;
		try {
			try { await load; } catch (error) {
				if (this.isDisposed) { throw canceled(error); }
				if (generation === this.catalogGeneration && connectionGeneration === this.appServer.connectionGeneration && this.catalogAttemptRevision === this.catalogRevision) { throw error; }
			}
			if (connectionGeneration !== this.appServer.connectionGeneration && this.modelCatalogLoad === load) { this.retireModelCatalog(); }
			// Retired callers must not publish an empty view after a pending successor publishes its rows.
			while (generation !== this.catalogGeneration && this.modelCatalogLoad && this.modelCatalogLoad !== load) {
				const successor: Promise<void> = this.modelCatalogLoad;
				try { await successor; } catch { /* The retired caller returns the current scope, including a failed empty scope. */ }
				if (successor === this.modelCatalogLoad) { break; }
			}
			if (this.isDisposed) { throw canceled(); }
			return this.modelCatalog;
		} finally {
			if (this.modelCatalogLoad === load) {
				this.modelCatalogLoad = undefined;
				// A notification can arrive after success or failure settles but before this cleanup.
				if (this.catalogAttemptRevision !== this.catalogRevision) { void this.refreshModels().catch(() => { }); }
			}
		}
	}

	private invalidateModelCatalog(): void {
		this.catalogRevision++;
		void this.refreshModels().catch(() => { });
	}

	private retireModelCatalog(forceNotification = false): void {
		this.catalogGeneration++;
		this.modelCatalogLoad = undefined;
		const hadModels = this.modelCatalog.length > 0 || this.providerState !== '[]';
		this.modelCatalog = Object.freeze([]);
		this.providerState = '[]';
		// Consumers retain their old array on read failure, so publish an empty current view now.
		this.hasLoadedModelCatalog = true;
		if ((hadModels || forceNotification) && !this.isDisposed) { this.changed.fire(); }
	}

	private isCurrentCatalogLoad(generation: number, connectionGeneration: number): boolean {
		if (this.isDisposed) { throw canceled(); }
		return generation === this.catalogGeneration && connectionGeneration === this.appServer.connectionGeneration;
	}

	private async loadModelCatalog(generation: number, connectionGeneration: number): Promise<void> {
		while (this.isCurrentCatalogLoad(generation, connectionGeneration)) {
			const revision = this.catalogRevision;
			this.catalogAttemptRevision = revision;
			try {
				const [catalog, providers, account] = await Promise.all([this.modelApi.listModels(), this.modelApi.listProviders(), this.accountState ?? this.accounts.read()]);
				if (!this.isCurrentCatalogLoad(generation, connectionGeneration)) { break; }
				if (revision !== this.catalogRevision) { continue; }
				// A hot daemon may have published its account event before this window subscribed.
				// Accept the snapshot only for the catalog attempt that requested it.
				this.accountState = account;
				const models = [...catalog.models];
				for (const connection of ['kimi-desktop', 'kimi-cli']) {
					if (!providers.providers.some(provider => provider.connection === connection && provider.ready)) { continue; }
					models.push(...await this.modelApi.listProviderModels(connection));
					if (!this.isCurrentCatalogLoad(generation, connectionGeneration) || revision !== this.catalogRevision) { break; }
				}
				if (!this.isCurrentCatalogLoad(generation, connectionGeneration)) { break; }
				if (revision !== this.catalogRevision) { continue; }
				this.acceptModelCatalog(models, providers);
				return;
			} catch (error) {
				if (!this.isCurrentCatalogLoad(generation, connectionGeneration)) { break; }
				if (revision !== this.catalogRevision) { continue; }
				throw error;
			}
		}
	}

	private acceptModelCatalog(entries: Readonly<ModelListResult['models']>, providers: ProviderListResult): void {
		const identities = new Set<string>();
		const catalog = entries.map(entry => {
			const identity = modelRefIdentity(entry.model);
			if (identities.has(identity)) { throw new Error(`Model catalog contains duplicate entry '${entry.model.provider}/${entry.model.model}'`); }
			identities.add(identity);
			return modelCatalogEntry(entry);
		});
		const providerState = JSON.stringify(modelProviderStatuses(providers));
		const changed = !sameModelCatalog(this.modelCatalog, catalog) || this.providerState !== providerState;
		this.modelCatalog = Object.freeze(catalog);
		this.providerState = providerState;
		this.modelAccountConnections = new Set(providers.providers.map(provider => provider.connection));
		if (this.accountState) { this.accountScope = accountCatalogScope(this.accountState, this.modelAccountConnections); }
		this.hasLoadedModelCatalog = true;
		if (changed) { this.changed.fire(); }
	}
}

function accountCatalogScope(account: AccountState, modelConnections: ReadonlySet<string> | undefined): string {
	// Internal token rotation and unrelated login integrations do not change model membership.
	return JSON.stringify(account.accounts.filter(entry => !modelConnections || modelConnections.has(entry.provider)).map(entry => JSON.stringify([entry.provider, entry.accountId, entry.organization, entry.plan, entry.status])).sort());
}

function modelProviderStatuses(result: ProviderListResult): ModelProviderCredentialStatus[] {
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

function modelCatalogEntry(entry: ModelListResult['models'][number]): ModelCatalogEntry {
	return Object.freeze({
		model: Object.freeze({ ...entry.model }),
		displayName: entry.display_name,
		inputModalities: entry.settings.input_modalities ? Object.freeze([...entry.settings.input_modalities]) : null,
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
			&& entry.inputModalities?.join(',') === candidate.inputModalities?.join(',')
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
