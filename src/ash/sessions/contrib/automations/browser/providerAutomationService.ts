import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { IAutomationDescriptor, IAutomationRun, IAutomationSchedule } from '../../../../workbench/contrib/chat/common/automations/automation.js';
import type {
	AutomationCatalogueState,
	IAutomationService,
	IAutomationStore,
	ICreateAutomationOptions,
	IUpdateAutomationOptions,
} from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

/** Aggregates borrowed provider state. No local fallback catalogue or execution path exists. */
export class ProviderAutomationService extends Disposable implements IAutomationService {
	private readonly providersChanged;
	readonly automations;
	readonly runs;
	readonly catalogueState;
	readonly historyState;
	readonly availableProviders;

	constructor(@ISessionsProvidersService private readonly providers: ISessionsProvidersService) {
		super();
		this.providersChanged = observableSignalFromEvent(this, providers.onDidChangeProviders);
		const stores = (reader: IReader) => {
			this.providersChanged.read(reader);
			return providers.getProviders().flatMap(provider => (provider.automations ? [{ provider, store: provider.automations }] : []));
		};
		this.automations = derived(reader =>
			stores(reader)
				.flatMap(({ store }) => store.automations.read(reader))
				.sort((a, b) => b.createdAt - a.createdAt),
		);
		this.runs = derived(reader =>
			stores(reader)
				.flatMap(({ store }) => store.runs.read(reader))
				.sort((a, b) => b.scheduledAt - a.scheduledAt),
		);
		this.catalogueState = derived<AutomationCatalogueState>(reader => {
			const states = stores(reader).map(({ store }) => store.catalogueState.read(reader));
			return states.includes('error') ? 'error' : states.includes('loading') ? 'loading' : !states.length || states.includes('unavailable') ? 'unavailable' : 'ready';
		});
		this.historyState = derived<AutomationCatalogueState>(reader => {
			const states = stores(reader).map(({ store }) => store.historyState?.read(reader) ?? 'ready');
			return states.includes('error') ? 'error' : states.includes('loading') ? 'loading' : !states.length || states.includes('unavailable') ? 'unavailable' : 'ready';
		});
		this.availableProviders = derived(reader =>
			stores(reader)
				.filter(({ store }) => store.catalogueState.read(reader) === 'ready')
				.map(({ provider }) => ({ id: provider.id, label: provider.label })),
		);
	}

	async refresh(): Promise<void> {
		await Promise.all(this.providers.getProviders().flatMap(provider => (provider.automations ? [provider.automations.refresh()] : [])));
	}

	canCreateAutomation(providerId: string | undefined): boolean {
		return !!providerId && this.availableProviders.get().some(provider => provider.id === providerId);
	}

	getAutomation(id: string): IAutomationDescriptor | undefined {
		return this.automations.get().find(item => item.id === id);
	}

	createAutomation(options: ICreateAutomationOptions) {
		return this.requireProvider(options.target.providerId).createAutomation(options);
	}

	updateAutomation(id: string, patch: IUpdateAutomationOptions) {
		return this.storeFor(id).updateAutomation(id, patch);
	}

	updateAutomationIfUnchanged(id: string, patch: IUpdateAutomationOptions, expected: IAutomationDescriptor) {
		return this.storeFor(id).updateAutomationIfUnchanged(id, patch, expected);
	}

	deleteAutomation(id: string) {
		return this.storeFor(id).deleteAutomation(id);
	}

	runAutomation(id: string, token?: CancellationToken) {
		return this.storeFor(id).runAutomation(id, token);
	}

	stopRun(run: IAutomationRun) {
		return this.requireProvider(run.providerId).stopRun(run);
	}

	readRunResult(run: IAutomationRun) {
		return this.requireProvider(run.providerId).readRunResult(run);
	}

	previewSchedule(providerId: string, schedule: IAutomationSchedule) {
		return this.requireProvider(providerId).previewSchedule(providerId, schedule);
	}

	canStopRun(run: IAutomationRun): boolean {
		return this.providers.getProvider(run.providerId)?.automations?.canStopRun(run) ?? false;
	}

	canRunAutomation(id: string): boolean {
		return this.findStore(id)?.canRunAutomation(id) ?? false;
	}

	canUpdateAutomation(id: string): boolean {
		return this.findStore(id)?.canUpdateAutomation(id) ?? false;
	}

	canDeleteAutomation(id: string): boolean {
		return this.findStore(id)?.canDeleteAutomation(id) ?? false;
	}

	private findStore(id: string): IAutomationStore | undefined {
		return this.providers.getProviders().find(provider => provider.automations?.getAutomation(id))?.automations;
	}

	private storeFor(id: string): IAutomationStore {
		const store = this.findStore(id);
		if (!store) throw new Error(localize('automations.missing', 'This automation or run is unavailable on its owning provider.'));
		return store;
	}

	private requireProvider(id: string): IAutomationStore {
		const store = this.providers.getProvider(id)?.automations;
		if (!store) throw new Error(localize('automations.hostUnavailable', 'Connect to the owning automation host and try again.'));
		return store;
	}
}
