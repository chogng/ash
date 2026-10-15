import { Disposable, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import type { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import type { IExtensionHostApi, ExtensionHostRuntime, ExtensionHostClientHandler, ExtensionHostInvocationRequest, ExtensionHostActivationRequest, ExtensionHostFleetSnapshot, JsonValue } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import type { ExtensionHostInitialization } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';

declare global {
	interface Window {
		__rustGitRequest(method: string, params?: unknown): Promise<JsonValue>;
		__rustGitClient(operation: unknown, context: { incarnation: number; activationGeneration: number; }): Promise<unknown>;
	}
}

/** Routes the Git test package through its Rust executable while the unrelated generic
 * SCM fixture keeps exercising the Worker host's public contract. */
export class RustGitHostFixture extends Disposable implements IExtensionHostApi {
	private readonly changed = this._register(new Emitter<number>());
	private readonly handlers = new Set<ExtensionHostClientHandler>();
	private current: ExtensionHostRuntime | undefined;
	private generation = 0;
	private controller = new AbortController();
	constructor(private readonly catalog: IExtensionApi, private readonly generic: IExtensionHostApi, private readonly initialization: () => ExtensionHostInitialization) {
		super();
		const changed = generic.onDidChange(() => this.changed.fire(++this.generation));
		this._register(toDisposable(() => changed.dispose()));
		window.__rustGitClient = async (raw, context) => {
			const operation = raw as import('../../../src/ash/workbench/api/common/extHost.protocol.js').ExtensionClientOperation;
			const current = this.current;
			if (!current || current.incarnation !== context.incarnation || current.activationGeneration !== context.activationGeneration) throw new Error('retired activation');
			if (operation.operation === 'scmUpdate') {
				this.current = { ...current, registrations: current.registrations.map(registration => registration.registrationId === operation.registrationId ? { ...registration, revision: operation.revision, providers: operation.providers } : registration) };
			}
			const source = { extensionId: 'ash.git', incarnation: context.incarnation, activationGeneration: context.activationGeneration };
			const handler = [...this.handlers][0];
			if (!handler) throw new Error('Missing Rust client handler');
			return handler(operation, this.controller.signal, source);
		};
		this._register(toDisposable(() => { this.controller.abort(); void window.__rustGitRequest('stop'); }));
	}
	registerClientHandler(handler: ExtensionHostClientHandler) {
		this.handlers.add(handler);
		const generic = this.generic.registerClientHandler(handler);
		return toDisposable(() => { this.handlers.delete(handler); generic.dispose(); });
	}
	async isAvailable() { return true; }
	async start() { return this.reconcile(); }
	async list(): Promise<ExtensionHostFleetSnapshot> {
		const generic = await this.generic.list();
		return { generation: this.generation, extensions: [...(this.current ? [this.current] : []), ...generic.extensions] };
	}
	async reconcile(_mode?: string): Promise<ExtensionHostFleetSnapshot> {
		const enabled = (await this.catalog.list('cached')).extensions.some(extension => extension.id === 'ash.git');
		if (!enabled && this.current) {
			this.controller.abort(); this.current = undefined;
			await window.__rustGitRequest('stop');
			this.changed.fire(++this.generation);
		} else if (enabled && !this.current) {
			this.controller = new AbortController();
			const result = await window.__rustGitRequest('start', this.initialization()) as unknown as { incarnation: number; registrations: ExtensionHostRuntime['registrations']; };
			this.current = { id: 'ash.git', version: '0.1.0', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1, incarnation: result.incarnation, activationGeneration: result.incarnation, lifecycle: 'ready', registrations: result.registrations, failure: undefined, stderr: '', outputEvents: [] };
			this.changed.fire(++this.generation);
		}
		await this.generic.reconcile('refresh');
		return this.list();
	}
	async activateByEvent(_request: ExtensionHostActivationRequest) { return this.reconcile(); }
	async invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		if (request.extensionId !== 'ash.git') return this.generic.invoke(request, signal);
		if (!this.current || request.incarnation !== this.current.incarnation || request.activationGeneration !== this.current.activationGeneration) throw new Error('retired activation');
		signal.throwIfAborted();
		const value = await window.__rustGitRequest('invoke', { registrationId: request.registrationId, operation: request.operation, payload: request.payload, deadlineUnixMillis: request.deadlineUnixMillis });
		signal.throwIfAborted(); return value;
	}
	async getConnectionState() { return 'ready' as const; }
	onDidChange = this.changed.event;
	onConnectionState = Event.None;
}
