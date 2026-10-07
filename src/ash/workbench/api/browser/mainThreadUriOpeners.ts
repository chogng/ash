import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { ExternalUriOpenerPriority } from '../../../editor/common/languages.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../common/contributions.js';
import { updateContributedOpeners } from '../../contrib/externalUriOpener/common/configuration.js';
import { IExternalUriOpenerService, type IExternalOpenerProvider, type IExternalUriOpener } from '../../contrib/externalUriOpener/common/externalUriOpenerService.js';

interface OpenerRegistration extends DisposableStore {
	readonly identity: string;
	readonly schemes: readonly string[];
	readonly opener: IExternalUriOpener;
}

/** Admits extension process registrations to the existing Workbench URL selection service. */
export class MainThreadUriOpeners extends Disposable implements IExternalOpenerProvider {
	private readonly registrations = this._register(new DisposableMap<string, OpenerRegistration>());
	private connectionEpoch = 0;
	private ready = false;
	private refreshRequested = false;
	private refreshPromise: Promise<void> | undefined;

	constructor(
		private readonly invocationTimeoutMillis: number,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IExternalUriOpenerService externalUriOpenerService: IExternalUriOpenerService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(externalUriOpenerService.registerExternalOpenerProvider(this));
		this._register(toDisposable(() => {
			this.connectionEpoch++;
			this.ready = false;
			updateContributedOpeners([], []);
		}));
	}

	public async start(): Promise<void> {
		const changed = this.api.onDidChange(() => this.requestRefresh());
		this._register(toDisposable(() => changed.dispose()));
		const connection = this.api.onConnectionState(state => {
			this.connectionEpoch++;
			this.ready = state === 'ready';
			this.registrations.clearAndDisposeAll();
			this.updateCompletionMetadata();
			this.requestRefresh();
		});
		this._register(toDisposable(() => connection.dispose()));
		const epoch = this.connectionEpoch;
		const state = await this.api.getConnectionState();
		if (!this.isDisposed && epoch === this.connectionEpoch) {
			this.ready = state === 'ready';
			this.requestRefresh();
		}
		await this.refreshPromise;
	}

	public async *getOpeners(targetUri: URI): AsyncIterable<IExternalUriOpener> {
		await this.refreshPromise;
		for (const [, registration] of this.registrations) {
			if (registration.schemes.includes(targetUri.scheme)) {
				yield registration.opener;
			}
		}
	}

	private requestRefresh(): void {
		if (!this.ready || this.isDisposed) { return; }
		this.refreshRequested = true;
		if (this.refreshPromise) { return; }
		this.refreshPromise = this.refresh().finally(() => {
			this.refreshPromise = undefined;
			if (this.refreshRequested) { this.requestRefresh(); }
		});
	}

	private async refresh(): Promise<void> {
		while (this.refreshRequested && this.ready && !this.isDisposed) {
			this.refreshRequested = false;
			const epoch = this.connectionEpoch;
			try {
				if (!await this.api.isAvailable()) { return; }
				const snapshot = await this.api.list();
				if (!this.isDisposed && epoch === this.connectionEpoch) { this.update(snapshot); }
			} catch (error) {
				if (!this.isDisposed && epoch === this.connectionEpoch) {
					this.logService.error('externalUriOpener', 'Could not read extension URL opener registrations', error);
				}
			}
		}
	}

	private update(snapshot: ExtensionHostFleetSnapshot): void {
		const active = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'externalUriOpener') { continue; }
				// The stable settings ID includes both owners, so packages cannot replace each other's handlers.
				const id = `extension:${encodeURIComponent(runtime.id)}:${encodeURIComponent(registration.registrationId)}`;
				active.add(id);
				const identity = JSON.stringify([runtime.incarnation, runtime.activationGeneration, registration]);
				if (this.registrations.get(id)?.identity === identity) { continue; }
				this.registrations.deleteAndDispose(id);
				const controller = new AbortController();
				const request = { extensionId: runtime.id, registrationId: registration.registrationId, incarnation: runtime.incarnation, activationGeneration: runtime.activationGeneration };
				const opener: IExternalUriOpener = {
					id, label: registration.label,
					canOpen: async (uri, token) => {
						const result = await this.invoke(request, controller.signal, 'canOpenExternalUri', { uri: uri.toString() }, token);
						if (result !== ExternalUriOpenerPriority.None && result !== ExternalUriOpenerPriority.Option && result !== ExternalUriOpenerPriority.Default && result !== ExternalUriOpenerPriority.Preferred) {
							throw new TypeError(`External URI opener '${id}' returned an invalid priority`);
						}
						return result;
					},
					openExternalUri: async (uri, ctx, token) => {
						const result = await this.invoke(request, controller.signal, 'openExternalUri', { resolvedUri: uri.toString(), sourceUri: ctx.sourceUri.toString() }, token);
						if (typeof result !== 'boolean') { throw new TypeError(`External URI opener '${id}' returned an invalid open result`); }
						return result;
					},
				};
				const scope = Object.assign(new DisposableStore(), { identity, schemes: registration.schemes, opener });
				scope.add(toDisposable(() => controller.abort('Extension URL opener was revoked')));
				this.registrations.set(id, scope);
			}
		}
		for (const id of this.registrations.keys()) {
			if (!active.has(id)) { this.registrations.deleteAndDispose(id); }
		}
		this.updateCompletionMetadata();
	}

	private updateCompletionMetadata(): void {
		const openers = [...this.registrations].map(([, registration]) => registration.opener);
		updateContributedOpeners(openers.map(opener => opener.id), openers.map(opener => opener.label));
	}

	private async invoke(identity: Pick<ExtensionHostInvocationRequest, 'extensionId' | 'registrationId' | 'incarnation' | 'activationGeneration'>, generation: AbortSignal, operation: string, payload: JsonValue, token: CancellationToken): Promise<JsonValue> {
		const controller = new AbortController();
		using subscription = token.onCancellationRequested(() => controller.abort('URL opening cancelled'));
		if (token.isCancellationRequested) { controller.abort('URL opening cancelled'); }
		const signal = AbortSignal.any([generation, controller.signal]);
		signal.throwIfAborted();
		const result = await this.api.invoke({ ...identity, operation, payload, deadlineUnixMillis: Date.now() + this.invocationTimeoutMillis }, signal);
		signal.throwIfAborted();
		return result;
	}
}

registerWorkbenchContribution('workbench.contrib.extensionUriOpeners', WorkbenchPhase.BlockRestore, accessor => {
	const openers = accessor.get(IInstantiationService).createInstance(MainThreadUriOpeners, 30_000);
	const logService = accessor.get(ILogService);
	void openers.start().catch(error => logService.error('externalUriOpener', 'Could not start extension URL openers', error));
	return openers;
});

