import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { canceled } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue, transaction, type IObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import type { Automation, AutomationDefinition, AutomationRun, IAutomationBackendService } from '../../../../../platform/agentHost/common/automation.js';
import type { IAutomationDescriptor, IAutomationRun, IAutomationRunResult, IAutomationSchedule } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import type { AutomationCatalogueState, ICreateAutomationOptions, IGuardedAutomationUpdateResult, IUpdateAutomationOptions, IAutomationRunRequestResult } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { ISessionsProviderAutomations } from '../../../../services/sessions/common/sessionsProvider.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';

/** One host's observable catalogue. It never schedules work or changes a run's authority. */
export class AgentHostAutomationStore extends Disposable implements ISessionsProviderAutomations {
	readonly catalogueState = observableValue<AutomationCatalogueState>(this, 'loading');
	readonly historyState = observableValue<AutomationCatalogueState>(this, 'loading');
	readonly automations = observableValue<readonly IAutomationDescriptor[]>(this, []);
	readonly runs = observableValue<readonly IAutomationRun[]>(this, []);
	private epoch = 0;
	// Catalogue writes also advance epoch; only carrier replacement retires operation receipts.
	private connectionEpoch = 0;
	private refreshAgain = false;
	private refreshing: Promise<void> | undefined;
	private readonly backend: IAutomationBackendService;

	constructor(
		private readonly providerId: string,
		private readonly connection: IObservable<'connecting' | 'connected' | 'disconnected'>,
		@IRendererHostService host: IRendererHost,
	) {
		super();
		if (!host.automation) throw new Error(localize('automations.hostUnavailable', 'Connect to the owning automation host and try again.'));
		this.backend = host.automation;
		this._register(this.backend.onDidChange(() => { void this.refresh().catch(() => { }); }));
		this._register(connection.onDidChange(state => {
			this.epoch++;
			this.connectionEpoch++;
			if (state === 'connected') void this.refresh().catch(() => { });
			else transaction(tx => {
				this.catalogueState.set(state === 'connecting' ? 'loading' : 'unavailable', tx);
				this.historyState.set(state === 'connecting' ? 'loading' : 'unavailable', tx);
			});
		}));
		this._register(toDisposable(() => {
			this.epoch++;
			this.catalogueState.set('unavailable', undefined);
			this.historyState.set('unavailable', undefined);
		}));
		void this.refresh().catch(() => { });
	}

	refresh(): Promise<void> {
		if (this.isDisposed || this.connection.get() !== 'connected') {
			transaction(tx => {
				this.catalogueState.set(this.connection.get() === 'connecting' ? 'loading' : 'unavailable', tx);
				this.historyState.set(this.connection.get() === 'connecting' ? 'loading' : 'unavailable', tx);
			});
			return Promise.resolve();
		}
		if (this.historyState.get() === 'error') this.historyState.set('loading', undefined);
		this.refreshAgain = true;
		return this.refreshing ??= this.readCatalogue().finally(() => { this.refreshing = undefined; });
	}

	private async readCatalogue(): Promise<void> {
		do {
			this.refreshAgain = false;
			const epoch = this.epoch;
			let definitions: readonly Automation[];
			try {
				definitions = await this.backend.list();
			} catch (error) {
				if (this.isDisposed) return;
				if (epoch !== this.epoch) continue;
				if (!this.isDisposed && epoch === this.epoch) this.catalogueState.set('error', undefined);
				throw error;
			}
			if (this.isDisposed) return;
			if (epoch !== this.epoch) continue;
			transaction(tx => {
				this.automations.set(definitions.map(item => this.descriptor(item)).sort((a, b) => b.createdAt - a.createdAt), tx);
				this.catalogueState.set('ready', tx);
			});
			const history: IAutomationRun[] = [];
			let historyError: { error: unknown; } | undefined;
			// Refresh histories independently, retaining the last rows for a failed definition.
			for (let index = 0; index < definitions.length; index += 4) {
				if (this.isDisposed || epoch !== this.epoch) break;
				const batch = definitions.slice(index, index + 4);
				const results = await Promise.allSettled(batch.map(item => this.backend.runs(item.id)));
				for (const [offset, result] of results.entries()) {
					if (result.status === 'fulfilled') history.push(...result.value.map(item => this.runDescriptor(item)));
					else {
						historyError ??= { error: result.reason };
						history.push(...this.runs.get().filter(run => run.automationId === this.identity(batch[offset]!.id)));
					}
				}
			}
			if (this.isDisposed) return;
			if (epoch !== this.epoch) continue;
			transaction(tx => {
				this.runs.set(history.sort((a, b) => b.scheduledAt - a.scheduledAt), tx);
				this.historyState.set(historyError ? 'error' : 'ready', tx);
			});
			if (historyError) throw historyError.error;
		} while (this.refreshAgain && !this.isDisposed && this.connection.get() === 'connected');
	}

	getAutomation(id: string): IAutomationDescriptor | undefined { return this.automations.get().find(item => item.id === id); }

	private getActiveRunFor(id: string): IAutomationRun | undefined { return this.runs.get().find(item => item.automationId === id && !terminal(item)); }

	canRunAutomation(id: string): boolean { return this.canUpdateAutomation(id) && !this.getActiveRunFor(id); }

	canUpdateAutomation(id: string): boolean { return this.catalogueState.get() === 'ready' && !!this.getAutomation(id); }

	canDeleteAutomation(id: string): boolean { return this.canUpdateAutomation(id) && !this.getActiveRunFor(id); }

	canStopRun(run: IAutomationRun): boolean { return this.connection.get() === 'connected' && run.providerId === this.providerId && !terminal(run); }

	async createAutomation(options: ICreateAutomationOptions): Promise<IAutomationDescriptor> {
		this.assertReady();
		this.assertTarget(options.target.providerId);
		const connectionEpoch = this.connectionEpoch;
		const value = await this.backend.save(generateUuid(), 0, definition(options), options.enabled === false ? 'paused' : 'enabled');
		return this.acceptAutomation(value, connectionEpoch);
	}

	async updateAutomation(id: string, patch: IUpdateAutomationOptions): Promise<IAutomationDescriptor> {
		const expected = this.requireAutomation(id);
		const result = await this.updateAutomationIfUnchanged(id, patch, expected);
		if (result.kind === 'conflict') throw new Error(localize('automations.editConflict', 'This automation changed. Refresh it before saving.'));
		return result.automation;
	}

	async updateAutomationIfUnchanged(id: string, patch: IUpdateAutomationOptions, expected: IAutomationDescriptor): Promise<IGuardedAutomationUpdateResult> {
		this.assertReady();
		const current = this.getAutomation(id);
		if (!current || current.revision !== expected.revision) return { kind: 'conflict', current };
		const options = { ...current, ...patch };
		this.assertTarget(options.target.providerId);
		const connectionEpoch = this.connectionEpoch;
		const value = await this.backend.save(this.backendId(id), expected.revision, definition(options), options.enabled ? 'enabled' : 'paused');
		return { kind: 'updated', automation: this.acceptAutomation(value, connectionEpoch) };
	}

	async deleteAutomation(id: string): Promise<void> {
		this.assertReady();
		const connectionEpoch = this.connectionEpoch;
		await this.backend.delete(this.backendId(id), this.requireAutomation(id).revision);
		if (this.isCurrentConnection(connectionEpoch)) {
			this.epoch++;
			transaction(tx => {
				this.automations.set(this.automations.get().filter(item => item.id !== id), tx);
				this.runs.set(this.runs.get().filter(item => item.automationId !== id), tx);
			});
			void this.refresh().catch(() => { });
		}
	}

	async runAutomation(id: string, token = CancellationToken.None): Promise<IAutomationRunRequestResult> {
		this.assertReady();
		if (token.isCancellationRequested) throw canceled();
		const connectionEpoch = this.connectionEpoch;
		const value = await this.backend.run(this.backendId(id));
		const run = this.runDescriptor(value);
		if (this.isCurrentConnection(connectionEpoch)) {
			this.epoch++;
			this.runs.set([run, ...this.runs.get().filter(item => item.id !== run.id)], undefined);
			void this.refresh().catch(() => { });
		}
		const whenCompleted = this.observeRun(run.id, connectionEpoch);
		// Observe rejection immediately, even when the caller is still processing admission.
		void whenCompleted.catch(() => { });
		return {
			kind: 'dispatched', run, whenCompleted,
			cancel: () => {
				if (this.isCurrentConnection(connectionEpoch)) void this.stopRun(run).catch(() => { });
			},
		};
	}

	async stopRun(run: IAutomationRun): Promise<void> {
		this.assertReady();
		this.assertTarget(run.providerId);
		const connectionEpoch = this.connectionEpoch;
		const value = await this.backend.stop(this.backendId(run.id));
		const updated = this.runDescriptor(value);
		if (this.isCurrentConnection(connectionEpoch)) {
			this.epoch++;
			this.runs.set([updated, ...this.runs.get().filter(item => item.id !== run.id)], undefined);
			void this.refresh().catch(() => { });
		}
	}

	async readRunResult(run: IAutomationRun): Promise<IAutomationRunResult> {
		this.assertReady();
		this.assertTarget(run.providerId);
		const connectionEpoch = this.connectionEpoch;
		const result = await this.backend.readResult({
			...run,
			id: this.backendId(run.id),
			automationId: this.backendId(run.automationId),
			definition: definition(run.definition),
		});
		if (!this.isCurrentConnection(connectionEpoch)) throw canceled();
		return result;
	}

	async previewSchedule(providerId: string, schedule: IAutomationSchedule): Promise<readonly number[]> {
		this.assertReady();
		this.assertTarget(providerId);
		const connectionEpoch = this.connectionEpoch;
		const result = await this.backend.preview(schedule);
		if (!this.isCurrentConnection(connectionEpoch)) throw canceled();
		return result;
	}

	private acceptAutomation(value: Automation, connectionEpoch: number): IAutomationDescriptor {
		const automation = this.descriptor(value);
		if (this.isCurrentConnection(connectionEpoch)) {
			// A successful write is final. Subsequent catalogue/history reads cannot turn it into a failed save.
			this.epoch++;
			this.automations.set([automation, ...this.automations.get().filter(item => item.id !== automation.id)].sort((a, b) => b.createdAt - a.createdAt), undefined);
			void this.refresh().catch(() => { });
		}
		return automation;
	}

	private observeRun(id: string, connectionEpoch: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const watching = new DisposableStore();
			let reading = false;
			let readAgain = false;
			const read = async (): Promise<void> => {
				reading = true;
				try {
					do {
						readAgain = false;
						// A run can leave the bounded history page as soon as it finishes.
						const run = await this.backend.getRun(this.backendId(id));
						if (watching.isDisposed) return;
						if (terminal(run)) {
							watching.dispose();
							resolve();
							return;
						}
						// A notification during the read may describe a newer state than its response.
					} while (readAgain);
				} catch (error) {
					if (!watching.isDisposed) {
						watching.dispose();
						reject(error);
					}
				} finally { reading = false; }
			};
			const update = (): void => {
				if (watching.isDisposed) return;
				const run = this.runs.get().find(item => item.id === id);
				if (!this.isCurrentConnection(connectionEpoch)) {
					watching.dispose();
					reject(new Error(localize('automations.observationLost', 'The automation host is unavailable. Its run may still be active.')));
				} else if (run && terminal(run)) {
					watching.dispose();
					resolve();
				} else {
					readAgain = true;
					if (!reading) void read();
				}
			};
			watching.add(this.backend.onDidChange(update));
			watching.add(this.runs.onDidChange(update));
			watching.add(this.catalogueState.onDidChange(update));
			watching.add(this.connection.onDidChange(update));
			update();
		});
	}

	private descriptor(value: Automation): IAutomationDescriptor {
		return {
			id: this.identity(value.id),
			name: value.definition.title,
			prompt: value.definition.prompt,
			target: { providerId: this.providerId, directory: value.definition.directory, session: value.definition.session },
			schedule: value.definition.schedule,
			enabled: value.status === 'enabled',
			revision: value.revision,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			nextRunAt: value.nextRunAt
		};
	}

	private runDescriptor(value: AutomationRun): IAutomationRun {
		return {
			...value,
			definition: {
				name: value.definition.title,
				prompt: value.definition.prompt,
				schedule: value.definition.schedule,
				target: { providerId: this.providerId, directory: value.definition.directory, session: value.definition.session },
			},
			id: this.identity(value.id),
			automationId: this.identity(value.automationId),
			providerId: this.providerId,
			sessionResource: value.sessionId && value.threadId ? URI.from({ scheme: 'ash-session', path: `/${value.sessionId}/${value.threadId}` }) : undefined
		};
	}

	private identity(id: string): string {
		return JSON.stringify([this.providerId, id]);
	}

	private backendId(id: string): string {
		let value: unknown;
		try { value = JSON.parse(id); } catch { /* Invalid public identity follows the same unavailable path. */ }
		if (Array.isArray(value) && value.length === 2 && value[0] === this.providerId && typeof value[1] === 'string' && value[1]) return value[1];
		throw new Error(localize('automations.missing', 'This automation or run is unavailable on its owning provider.'));
	}

	private requireAutomation(id: string): IAutomationDescriptor {
		const value = this.getAutomation(id);
		if (!value) throw new Error(localize('automations.missing', 'This automation or run is unavailable on its owning provider.'));
		return value;
	}

	private assertReady(): void {
		if (this.isDisposed || this.connection.get() !== 'connected') throw new Error(localize('automations.hostUnavailable', 'Connect to the owning automation host and try again.'));
	}

	private isCurrentConnection(connectionEpoch: number): boolean {
		return !this.isDisposed && this.connection.get() === 'connected' && connectionEpoch === this.connectionEpoch;
	}

	private assertTarget(providerId: string): void {
		if (providerId !== this.providerId) throw new Error(localize('automations.providerMismatch', 'An automation cannot be moved to another provider. Create a new automation on that provider.'));
	}
}

function definition(options: ICreateAutomationOptions): AutomationDefinition {
	return {
		title: options.name,
		prompt: options.prompt,
		directory: options.target.directory,
		session: options.target.session,
		schedule: options.schedule
	};
}

function terminal(run: Pick<IAutomationRun, 'status'>): boolean { return ['completed', 'failed', 'stopped', 'skipped'].includes(run.status); }
