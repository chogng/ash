import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import Severity from '../../../../../base/common/severity.js';
import { localize } from '../../../../../nls.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../common/languageModels.js';

export const MODEL_ENTRY_TEMPLATE_ID = 'model.entry.template';
export const VENDOR_ENTRY_TEMPLATE_ID = 'vendor.entry.template';

/** Only advertise capabilities backed by the current catalog contract. */
export const SEARCH_SUGGESTIONS = {
	FILTER_TYPES: ['@provider:', '@capability:'],
	CAPABILITIES: ['@capability:vision'],
};

export interface ILanguageModelProvider {
	readonly vendor: { readonly vendor: string; readonly displayName: string };
	readonly group: { readonly vendor: string; readonly name: string };
}

/** Keeps the domain catalog entry intact; presentation does not invent transport metadata. */
export interface ILanguageModel extends ModelCatalogEntry {
	readonly identifier: string;
	readonly provider: ILanguageModelProvider;
	readonly hidden: boolean;
}

export interface ILanguageModelEntry {
	readonly type: 'model';
	readonly id: string;
	readonly templateId: string;
	readonly model: ILanguageModel;
}

export interface ILanguageModelProviderEntry {
	readonly type: 'vendor';
	readonly id: string;
	readonly label: string;
	readonly templateId: string;
	readonly collapsed: boolean;
	readonly hidden: boolean;
	readonly vendorEntry: ILanguageModelProvider;
}

export interface IStatusEntry {
	readonly type: 'status';
	readonly id: string;
	readonly message: string;
	readonly severity: Severity;
}

export type IViewModelEntry = ILanguageModelEntry | ILanguageModelProviderEntry | IStatusEntry;

export interface IViewModelChangeEvent {
	readonly at: number;
	readonly removed: number;
	readonly added: IViewModelEntry[];
}

export function isLanguageModelProviderEntry(entry: IViewModelEntry): entry is ILanguageModelProviderEntry {
	return entry.type === 'vendor';
}
export function isStatusEntry(entry: IViewModelEntry): entry is IStatusEntry {
	return entry.type === 'status';
}
export function getManageModelsProviderLabel(model: ILanguageModel): string {
	return model.provider.group.name;
}

/** Owns the catalog projection. Durable visibility and provider declarations remain in their services. */
export class ChatModelsViewModel extends Disposable {
	private readonly changed = this._register(new Emitter<IViewModelChangeEvent>());
	public readonly onDidChange = this.changed.event;
	private catalog: readonly ModelCatalogEntry[] = [];
	private vendors: ILanguageModelProvider['vendor'][] = [];
	private entries: IViewModelEntry[] = [];
	private readonly collapsed = new Set<string>();
	private query = '';
	private dirty = true;
	private generation = 0;
	private failure: IStatusEntry | undefined;
	public selectedEntry: IViewModelEntry | undefined;

	constructor(@ILanguageModelsService private readonly models: ILanguageModelsService) {
		super();
		this._register(
			models.onDidChangeModels(() => {
				this.dirty = true;
				this.rebuild();
				void this.refresh().catch(() => {
					/* The current failure is published as a status entry. */
				});
			}),
		);
	}

	public get viewModelEntries(): readonly IViewModelEntry[] {
		return this.entries;
	}
	public shouldRefilter(): boolean {
		return this.dirty;
	}
	public getVendors(): ILanguageModelProvider['vendor'][] {
		return [...new Map([...this.getConfiguredVendors().map(provider => provider.vendor), ...this.vendors].map(vendor => [vendor.vendor, vendor])).values()];
	}

	public filter(searchValue: string): readonly IViewModelEntry[] {
		if (this.query !== searchValue || this.dirty) {
			if (this.query !== searchValue) {
				this.collapsed.clear();
			}
			this.query = searchValue;
			this.rebuild();
		}
		return this.entries;
	}

	public async refresh(): Promise<void> {
		const generation = ++this.generation;
		// Credential observations must not hold the catalog hostage to an unrelated pending key read.
		void this.models
			.listModelProviders()
			.then(providers => {
				if (this.isDisposed || generation !== this.generation) {
					return;
				}
				this.vendors = providers.map(provider => ({
					vendor: provider.connection,
					displayName: provider.displayName,
				}));
				this.rebuild();
			})
			.catch(() => {
				/* Connection IDs remain usable labels when provider metadata is unavailable. */
			});
		try {
			const catalog = await this.models.listModelCatalog();
			if (this.isDisposed || generation !== this.generation) {
				return;
			}
			this.catalog = catalog;
			this.failure = undefined;
			this.rebuild();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) {
				return;
			}
			this.failure = {
				type: 'status',
				id: 'models.catalog.error',
				severity: Severity.Error,
				message: localize('sessions.settings.modelsLoadFailed', 'Could not load models.'),
			};
			this.rebuild();
			throw error;
		}
	}

	public getConfiguredVendors(): ILanguageModelProvider[] {
		return [...new Set(this.catalog.map(entry => entry.model.provider))].map(id => this.provider(id));
	}

	public getModelsForGroup(group: ILanguageModelProviderEntry): ILanguageModel[] {
		return this.catalog.filter(entry => entry.model.provider === group.vendorEntry.group.vendor).map(entry => this.model(entry));
	}

	public toggleModelHidden(entry: ILanguageModelEntry): Promise<void> {
		return this.setModelsHidden([entry], !entry.model.hidden);
	}

	public async toggleGroupHidden(entry: ILanguageModelProviderEntry): Promise<void> {
		const models = this.getModelsForGroup(entry);
		await this.setModelsHidden(
			models.map(model => this.entry(model)),
			!models.every(model => model.hidden),
		);
	}

	/** Persistence is asynchronous in Ash; errors reach the invoking control instead of disappearing. */
	public async setModelsHidden(entries: readonly ILanguageModelEntry[], hidden: boolean): Promise<void> {
		try {
			for (const entry of entries) {
				await this.models.setModelVisible(entry.model.model, !hidden);
			}
		} finally {
			if (!this.isDisposed) {
				this.rebuild();
			}
		}
	}

	public toggleCollapsed(entry: IViewModelEntry): void {
		if (!isLanguageModelProviderEntry(entry)) {
			return;
		}
		if (this.collapsed.has(entry.id)) {
			this.collapsed.delete(entry.id);
		} else {
			this.collapsed.add(entry.id);
		}
		this.rebuild();
	}

	public collapseAll(): void {
		for (const provider of this.getConfiguredVendors()) {
			this.collapsed.add(this.groupId(provider));
		}
		this.rebuild();
	}

	private provider(id: string): ILanguageModelProvider {
		const vendor = this.vendors.find(vendor => vendor.vendor === id) ?? { vendor: id, displayName: id };
		return { vendor, group: { vendor: id, name: vendor.displayName } };
	}

	private model(entry: ModelCatalogEntry): ILanguageModel {
		return {
			...entry,
			identifier: modelRefIdentity(entry.model),
			provider: this.provider(entry.model.provider),
			hidden: !this.models.isModelVisible(entry.model),
		};
	}

	private entry(model: ILanguageModel): ILanguageModelEntry {
		return { type: 'model', id: model.identifier, templateId: MODEL_ENTRY_TEMPLATE_ID, model };
	}

	private groupId(provider: ILanguageModelProvider): string {
		return `provider:${provider.group.vendor}`;
	}

	private rebuild(): void {
		const providers: string[] = [];
		const capabilities: string[] = [];
		const text = this.query
			.replace(/@provider:\s*(?:"([^"]*)"|(\S+))/giu, (_match, quoted: string | undefined, plain: string | undefined) => {
				providers.push((quoted ?? plain ?? '').toLocaleLowerCase());
				return '';
			})
			.replace(/@capability:\s*(\S+)/giu, (_match, value: string) => {
				capabilities.push(value.toLocaleLowerCase());
				return '';
			});
		const terms = (text.match(/"[^"]*"|\S+/gu) ?? []).map(term => term.replace(/^"|"$/gu, '').toLocaleLowerCase());
		const groups = this.getConfiguredVendors();
		const next: IViewModelEntry[] = [];
		if (this.failure) {
			next.push(this.failure);
		}
		for (const provider of groups) {
			const providerText = `${provider.vendor.vendor} ${provider.vendor.displayName}`.toLocaleLowerCase();
			if (providers.length && !providers.some(value => providerText.includes(value))) {
				continue;
			}
			const groupModels = this.catalog.filter(entry => entry.model.provider === provider.group.vendor).map(entry => this.model(entry));
			const models = groupModels.filter(model => {
				if (!capabilities.every(capability => capability === 'vision' && model.inputModalities?.includes('image') === true)) {
					return false;
				}
				const searchable = `${model.displayName} ${model.model.provider}/${model.model.model} ${providerText} ${model.inputModalities?.includes('image') ? 'vision' : ''}`.toLocaleLowerCase();
				return terms.every(term => searchable.includes(term));
			});
			if (!models.length) {
				continue;
			}
			const id = this.groupId(provider);
			const collapsed = this.collapsed.has(id);
			if (groups.length > 1) {
				next.push({
					type: 'vendor',
					id,
					label: provider.group.name,
					templateId: VENDOR_ENTRY_TEMPLATE_ID,
					collapsed,
					hidden: groupModels.every(model => model.hidden),
					vendorEntry: provider,
				});
			}
			if (!collapsed || groups.length === 1) {
				next.push(...models.map(model => this.entry(model)));
			}
		}
		const removed = this.entries.length;
		const selection = this.selectedEntry?.id;
		this.entries = next;
		this.selectedEntry = selection ? next.find(entry => entry.id === selection) : undefined;
		this.dirty = false;
		this.changed.fire({ at: 0, removed, added: next });
	}
}
