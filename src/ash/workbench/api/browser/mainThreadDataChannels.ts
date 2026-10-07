import { RunOnceScheduler } from '../../../base/common/async.js';
import { runWithBufferedEvents } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { observableValue } from '../../../base/common/observable.js';
import type { URI } from '../../../base/common/uri.js';
import { IDataChannelService, ILinkPresentationService, parseLinkPresentation, type ILinkPresentation, type ILinkPresentationWatcher } from '../../../platform/dataChannel/common/dataChannel.js';
import { IExtensionHostApi, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { ILogService } from '../../../platform/log/common/log.js';

interface RegistrationScope extends DisposableStore {
	readonly identity: string;
}

/** Binds channel subscriptions and link providers to exact extension process registrations. */
export class MainThreadDataChannels extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, RegistrationScope>());
	private connectionEpoch = 0;
	private ready = false;
	private refreshRequested = false;
	private refreshPromise: Promise<void> | undefined;

	constructor(
		private readonly invocationTimeoutMillis: number,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IDataChannelService private readonly channels: IDataChannelService,
		@ILinkPresentationService private readonly links: ILinkPresentationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			this.connectionEpoch++;
			this.ready = false;
		}));
	}

	public async start(): Promise<void> {
		const changed = this.api.onDidChange(() => this.requestRefresh());
		this._register(toDisposable(() => changed.dispose()));
		const connection = this.api.onConnectionState(state => {
			this.connectionEpoch++;
			this.ready = state === 'ready';
			this.registrations.clearAndDisposeAll();
			if (this.ready) {
				this.requestRefresh();
			}
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

	private requestRefresh(): void {
		if (!this.ready || this.isDisposed) {
			return;
		}
		this.refreshRequested = true;
		if (this.refreshPromise) {
			return;
		}
		this.refreshPromise = this.refresh().finally(() => {
			this.refreshPromise = undefined;
			if (this.refreshRequested) {
				this.requestRefresh();
			}
		});
	}

	private async refresh(): Promise<void> {
		while (this.refreshRequested && this.ready && !this.isDisposed) {
			this.refreshRequested = false;
			const epoch = this.connectionEpoch;
			try {
				if (!await this.api.isAvailable()) {
					return;
				}
				const snapshot = await this.api.list();
				if (!this.isDisposed && epoch === this.connectionEpoch) {
					this.update(snapshot);
				}
			} catch (error) {
				if (!this.isDisposed && epoch === this.connectionEpoch) {
					this.logService.error('dataChannel', 'Could not read extension channel registrations', error);
				}
			}
		}
	}

	private update(snapshot: ExtensionHostFleetSnapshot): void {
		this.assertNotDisposed();
		// Publish the complete registration set before consumers rebind their visible links.
		runWithBufferedEvents(() => this.applyRegistrations(snapshot));
	}

	private applyRegistrations(snapshot: ExtensionHostFleetSnapshot): void {
		const active = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) {
				continue;
			}
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'dataChannel' && registration.kind !== 'linkPresentationProvider') {
					continue;
				}
				const key = `${runtime.id}\0${registration.registrationId}`;
				active.add(key);
				// Output also advances the fleet generation; only this process registration owns the subscription.
				const identity = JSON.stringify([runtime.incarnation, runtime.activationGeneration, registration]);
				if (this.registrations.get(key)?.identity === identity) {
					continue;
				}
				this.registrations.deleteAndDispose(key);
				const store: RegistrationScope = Object.assign(new DisposableStore(), { identity });
				this.registrations.set(key, store);
				const controller = new AbortController();
				store.add(toDisposable(() => controller.abort('Extension registration was revoked')));
				const invoke = async (operation: string, payload: JsonValue, signal: AbortSignal): Promise<JsonValue> => {
					const cancellation = AbortSignal.any([controller.signal, signal]);
					const result = await this.api.invoke({
						extensionId: runtime.id,
						registrationId: registration.registrationId,
						incarnation: runtime.incarnation!,
						activationGeneration: runtime.activationGeneration,
						operation,
						payload,
						deadlineUnixMillis: Date.now() + this.invocationTimeoutMillis,
					}, cancellation);
					cancellation.throwIfAborted();
					return result;
				};
				if (registration.kind === 'dataChannel') {
					const queue: JsonValue[] = [];
					let draining = false;
					store.add(toDisposable(() => queue.length = 0));
					const drain = async (): Promise<void> => {
						draining = true;
						try {
							while (queue.length > 0 && !controller.signal.aborted) {
								const payload = queue.shift()!;
								try {
									await invoke('receiveData', payload, controller.signal);
								} catch (error) {
									if (!controller.signal.aborted) {
										this.logService.error('dataChannel', `Extension '${runtime.id}' could not receive channel data`, error);
									}
								}
							}
						} finally {
							draining = false;
						}
					};
					store.add(this.channels.onDidSendData(event => {
						if (event.channelId !== registration.channelId) {
							return;
						}
						if (queue.length >= 32) {
							this.logService.error('dataChannel', `Extension '${runtime.id}' exceeded its channel delivery queue`);
							return;
						}
						queue.push(normalizeExtensionHostPayload({ data: event.data }));
						if (!draining) {
							void drain();
						}
					}));
				} else {
					store.add(this.links.registerLinkPresentationProvider({
						id: `extension:${encodeURIComponent(runtime.id)}:${encodeURIComponent(registration.registrationId)}`,
						uriPattern: new RegExp(registration.uriPattern),
						kind: registration.presentationKind,
					}, {
						createLinkPresentationWatcher: resource => {
							const watcher = new ExtensionLinkPresentationWatcher(resource, registration.presentationKind, invoke, this.logService);
							watcher.start();
							return watcher;
						},
					}));
				}
			}
		}
		for (const key of this.registrations.keys()) {
			if (!active.has(key)) {
				this.registrations.deleteAndDispose(key);
			}
		}
	}
}

class ExtensionLinkPresentationWatcher extends Disposable implements ILinkPresentationWatcher {
	public readonly presentation = observableValue<ILinkPresentation | undefined>(this, undefined);
	private readonly controller = new AbortController();
	// Host v1 exposes a query, so each visible link owns its polling and cancellation lifetime.
	private readonly scheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 30_000));

	constructor(
		private readonly resource: URI,
		private readonly kind: ILinkPresentation['kind'],
		private readonly invoke: (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
		private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			this.controller.abort('Link watcher was disposed');
			this.presentation.set(undefined);
		}));
	}

	public start(): void {
		this.scheduler.schedule(0);
	}

	private async refresh(): Promise<void> {
		try {
			const result = await this.invoke('provideLinkPresentation', { resource: this.resource.toString() }, this.controller.signal);
			const presentation = result === null ? undefined : parseLinkPresentation(result);
			if (presentation && presentation.kind !== this.kind) {
				throw new TypeError('Link provider returned a different presentation kind');
			}
			this.controller.signal.throwIfAborted();
			this.presentation.set(presentation);
			this.scheduler.schedule();
		} catch (error) {
			if (!this.controller.signal.aborted) {
				this.presentation.set(undefined);
				this.logService.error('linkPresentation', 'Extension link presentation failed', error);
			}
		}
	}
}
