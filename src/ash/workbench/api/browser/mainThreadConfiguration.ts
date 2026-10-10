import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IConfigurationService, type IConfigurationChange } from '../../../platform/configuration/common/configuration.js';
import { IExtensionHostApi, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';

/** ConfigurationService owns values; this bridge retains only ordered, fenced deliveries. */
export class MainThreadConfiguration extends Disposable {
	private readonly observers = this._register(new DisposableMap<string, ConfigurationObserver>());
	private revision = 0;

	constructor(
		private readonly timeoutMillis: number,
		private readonly reportError: (error: unknown) => void,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			const payload = this.snapshot(event.change);
			for (const [, observer] of this.observers) observer.send(payload);
		}));
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const retained = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'workspaceEvents') continue;
				const identity = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation, registrationId: registration.registrationId };
				const key = JSON.stringify(identity);
				retained.add(key);
				if (this.observers.has(key)) continue;
				const observer = new ConfigurationObserver((event, signal) => this.api.invoke({ ...identity, operation: 'workspaceEvent', payload: event, deadlineUnixMillis: Date.now() + this.timeoutMillis }, signal), this.reportError);
				this.observers.set(key, observer);
				observer.send(this.snapshot());
			}
		}
		for (const key of this.observers.keys()) if (!retained.has(key)) this.observers.deleteAndDispose(key);
	}

	public clear(): void { this.observers.clearAndDisposeAll(); }

	private snapshot(change?: IConfigurationChange): JsonValue {
		return normalizeExtensionHostPayload({
			type: 'configuration', revision: ++this.revision, emit: change !== undefined,
			configurationValues: this.configuration.getValue(), configurationData: this.configuration.getConfigurationData(),
			change: change ? { keys: [...change.keys], overrides: change.overrides.map(([identifier, keys]) => [identifier, [...keys]]) } : { keys: [], overrides: [] },
		});
	}
}

class ConfigurationObserver extends Disposable {
	private readonly controller = new AbortController();
	private queue: Promise<void> = Promise.resolve();
	private pending = 0;

	constructor(private readonly invoke: (event: JsonValue, signal: AbortSignal) => Promise<JsonValue>, private readonly reportError: (error: unknown) => void) { super(); }

	public send(snapshot: JsonValue): void {
		if (this.controller.signal.aborted) return;
		if (++this.pending > 64) {
			this.controller.abort();
			this.reportError(new Error(localize({ bundle: 'ash.workbench', key: 'configurationEventsOverflow' }, 'Extension configuration event queue exceeded 64 pending events.')));
			return;
		}
		this.queue = this.queue.then(async () => {
			throwIfCancelled(this.controller.signal);
			await this.invoke(snapshot, this.controller.signal);
		}).catch(error => {
			if (!this.controller.signal.aborted) this.reportError(error);
		}).finally(() => { this.pending--; });
	}

	protected override disposeCore(): void { this.controller.abort(); super.disposeCore(); }
}
