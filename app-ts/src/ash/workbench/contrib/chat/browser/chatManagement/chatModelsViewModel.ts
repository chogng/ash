import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { CustomModelProvider } from '../../../../../platform/sessions/common/sessionApi.js';
import { ILanguageModelsService } from '../../common/languageModels.js';

export interface ProviderModelItem {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly manual: boolean;
	readonly upstreamModel?: string;
	status: 'untested' | 'testing' | 'passed' | 'failed';
	message?: string;
}

/** Provider declarations are durable; discovery and probe results belong to this open card. */
export class ChatModelsViewModel extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private configuration: CustomModelProvider;
	private saved: string;
	private writes: Promise<void> = Promise.resolve();
	private discovered: readonly { id: string; name: string; contextWindow?: number }[] = [];
	private items: ProviderModelItem[] = [];
	private generation = 0;
	private _busy = false;
	private _message = '';
	private _error = false;

	constructor(provider: CustomModelProvider, isNew: boolean,
		@ILanguageModelsService private readonly models: ILanguageModelsService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.configuration = provider;
		this.saved = isNew ? '' : JSON.stringify(provider);
		this.mergeItems();
		this._register(models.onDidChangeModels(() => this.changed.fire()));
	}

	public get provider(): CustomModelProvider { return this.configuration; }
	public get rows(): readonly ProviderModelItem[] { return this.items; }
	public get busy(): boolean { return this._busy; }
	public get message(): string { return this._message; }
	public get isError(): boolean { return this._error; }

	public async initialize(): Promise<void> {
		const generation = this.generation;
		try {
			const catalog = await this.models.listModelCatalog();
			if (this.isDisposed || generation !== this.generation) { return; }
			this.discovered = catalog.filter(entry => entry.model.provider === this.configuration.id && entry.discovered === true)
				.map(entry => ({ id: entry.model.model, name: entry.displayName, contextWindow: entry.contextWindow ?? undefined }));
			this.mergeItems();
			this.changed.fire();
		} catch (error) {
			if (!this.isDisposed) { this.report(error); }
		}
	}

	public updateProvider(value: Pick<CustomModelProvider, 'name' | 'baseUrl' | 'apiFormat'>): void {
		if (JSON.stringify(value) === JSON.stringify({ name: this.provider.name, baseUrl: this.provider.baseUrl, apiFormat: this.provider.apiFormat })) { return; }
		const connectionChanged = value.baseUrl !== this.provider.baseUrl || value.apiFormat !== this.provider.apiFormat;
		this.configuration = { ...this.provider, ...value };
		if (connectionChanged) { this.discovered = []; this.mergeItems(); }
		this.invalidateTests();
	}

	public invalidateTests(): void {
		this.generation++;
		for (const row of this.items) { row.status = 'untested'; row.message = undefined; }
		this._message = '';
		this._error = false;
		this.changed.fire();
	}

	public isEnabled(id: string): boolean { return this.models.isModelVisible({ provider: this.provider.id, model: id }); }

	public async setEnabled(id: string, enabled: boolean): Promise<void> {
		try { await this.models.setModelVisible({ provider: this.provider.id, model: id }, enabled); }
		catch (error) { this.report(error); }
		finally { if (!this.isDisposed) { this.changed.fire(); } }
	}

	public async addModel(id: string, contextWindow: number, upstreamModel?: string): Promise<void> {
		if (!id.trim() || /\s|\p{Cc}/u.test(id)) { throw new Error(localize('models.provider.modelRequired', 'Enter a model ID.')); }
		if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || contextWindow > 0xffff_ffff) {
			throw new Error(localize('models.provider.contextInvalid', 'Enter a positive context window in tokens.'));
		}
		if (upstreamModel && /\s|\p{Cc}/u.test(upstreamModel)) { throw new Error(localize('models.provider.modelRequired', 'Enter a model ID.')); }
		const config = { ...this.provider, models: [...this.provider.models.filter(model => model.id !== id), { id, contextWindow, ...(upstreamModel ? { upstreamModel } : {}) }] };
		this._busy = true;
		this.changed.fire();
		try {
			await this.write(config);
			this.configuration = config;
			this.mergeItems();
			this.invalidateTests();
		} finally {
			this._busy = false;
			this.changed.fire();
		}
	}

	public async removeModel(id: string): Promise<void> {
		const config = { ...this.provider, models: this.provider.models.filter(model => model.id !== id) };
		this._busy = true;
		this.changed.fire();
		try {
			await this.write(config);
			this.configuration = config;
			this.mergeItems();
			// A discovered ID stays in the endpoint table after its manual metadata is removed.
			await this.models.setModelVisible({ provider: this.provider.id, model: id }, false);
		} finally {
			this._busy = false;
			this.changed.fire();
		}
	}

	public save(): Promise<void> { return this.write(this.provider); }

	private write(config: CustomModelProvider): Promise<void> {
		const fingerprint = JSON.stringify(config);
		const operation = this.writes.then(async () => {
			if (fingerprint === this.saved) { return; }
			if (!config.name || config.name.length > 80 || /\p{Cc}/u.test(config.name)) { throw new Error(localize('models.provider.nameRequired', 'Enter a provider name of 1–80 characters.')); }
			let url: URL;
			try { url = new URL(config.baseUrl); } catch { throw new Error(localize('models.provider.urlInvalid', 'Enter a valid HTTP or HTTPS base URL.')); }
			if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) { throw new Error(localize('models.provider.urlInvalid', 'Enter a valid HTTP or HTTPS base URL.')); }
			await this.models.saveCustomModelProvider(config);
			this.saved = fingerprint;
			await this.models.refreshModels();
		});
		this.writes = operation.catch(() => {});
		return operation;
	}

	public async refresh(before: () => Promise<void>): Promise<void> {
		await this.run(before, async () => {
			await this.discover();
			this._message = this.items.length ? localize('models.provider.loaded', '{0} models loaded.', this.items.length) : localize('models.provider.empty', 'The endpoint returned no models. Add a model ID manually.');
		});
	}

	public async testModels(before: () => Promise<void>): Promise<void> {
		await this.run(before, async () => {
			if (!this.items.length) { await this.discover(); }
			if (!this.items.length) { throw new Error(localize('models.provider.empty', 'The endpoint returned no models. Add a model ID manually.')); }
			const generation = this.generation;
			const provider = this.provider;
			let passed = 0;
			const rows = [...this.items];
			for (const [index, row] of rows.entries()) {
				if (this.isDisposed || generation !== this.generation) { return; }
				row.status = 'testing';
				this._message = localize('models.provider.progress', 'Testing {0} of {1}: {2}', index + 1, rows.length, row.id);
				this.changed.fire();
				try {
					const result = await this.models.testProviderModel(provider, row.id);
					if (this.isDisposed || generation !== this.generation) { return; }
					row.status = result.type === 'passed' ? 'passed' : 'failed';
					row.message = result.type === 'failed' ? result.message : undefined;
					if (result.type === 'passed') { passed++; }
				} catch (error) {
					if (this.isDisposed || generation !== this.generation) { return; }
					row.status = 'failed';
					row.message = error instanceof Error ? error.message : String(error);
				}
				this.changed.fire();
			}
			this._message = localize('models.provider.summary', '{0}: {1} of {2} models passed.', provider.name, passed, rows.length);
			this._error = passed !== rows.length;
			if (this._error) { this.notifications.warning(this._message); }
			else { this.notifications.info(this._message); }
		});
	}

	private async discover(): Promise<void> {
		const catalog = await this.models.discoverProviderModels(this.provider.id);
		if (this.isDisposed) { return; }
		this.discovered = catalog.map(entry => ({ id: entry.model.model, name: entry.displayName, contextWindow: entry.contextWindow ?? undefined }));
		this.mergeItems();
	}

	private mergeItems(): void {
		const previous = new Map(this.items.map(row => [row.id, row]));
		const rows = new Map<string, ProviderModelItem>();
		for (const model of this.discovered) { rows.set(model.id, { ...model, manual: false, status: 'untested' }); }
		for (const model of this.provider.models) { rows.set(model.id, { id: model.id, name: rows.get(model.id)?.name ?? model.id, contextWindow: model.contextWindow, upstreamModel: model.upstreamModel, manual: true, status: 'untested' }); }
		this.items = [...rows.values()].map(row => ({ ...row, status: previous.get(row.id)?.status ?? 'untested', message: previous.get(row.id)?.message }));
	}

	private async run(before: () => Promise<void>, operation: () => Promise<void>): Promise<void> {
		if (this._busy) { return; }
		this._busy = true;
		this._error = false;
		this.changed.fire();
		try { await before(); await operation(); }
		catch (error) { if (!this.isDisposed) { this.report(error); } }
		finally { if (!this.isDisposed) { this._busy = false; this.changed.fire(); } }
	}

	public report(error: unknown): void {
		if (this.isDisposed) { return; }
		this._message = localize('models.provider.operationFailed', 'Could not update {0}: {1}', this.provider.name || localize('models.provider.new', 'New provider'), error instanceof Error ? error.message : String(error));
		this._error = true;
		this.notifications.error(this._message);
		this.changed.fire();
	}
}
