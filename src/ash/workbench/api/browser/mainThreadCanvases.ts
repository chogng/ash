import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionClientSource, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { IAgentHostCanvasCollection, type ICanvasProvider } from '../../contrib/canvases/common/agentHostCanvas.js';
import type { ICanvasOwner } from '../../contrib/canvases/common/canvas.js';
import { normalizeBrowserViewUrl } from '../../../platform/browserView/common/browserView.js';
import { ILogService } from '../../../platform/log/common/log.js';

/** Binds the existing versioned DataChannel capability to the package's declared Canvas types. */
export class MainThreadCanvases extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly bindings = new Map<string, { identity: string; source: ExtensionClientSource; provider?: ICanvasProvider; settled?: boolean; }>();
	private readonly suspended = new Set<string>();
	private readonly readyOwners = new Set<string>();
	constructor(private readonly timeout: number,
		@IExtensionHostApi private readonly runtime: IExtensionHostApi,
		@IExtensionService private readonly extensions: IExtensionService,
		@IAgentHostCanvasCollection private readonly canvases: IAgentHostCanvasCollection,
		@ILogService private readonly log: ILogService,
	) { super(); }

	update(snapshot: ExtensionHostFleetSnapshot): void {
		this.readyOwners.clear();
		for (const owner of snapshot.extensions) { if (owner.lifecycle === 'ready') { this.readyOwners.add(owner.id); } }
		for (const extensionId of this.suspended) {
			const owner = snapshot.extensions.find(owner => owner.id === extensionId);
			if (!owner || owner.lifecycle === 'stopped') { this.canvases.retireExtension(extensionId); this.suspended.delete(extensionId); }
		}
		const declarations = this.extensions.getExtensionPointContributions<readonly { id: string; displayName: string; description: string; requiresInput: boolean; }[]>('canvases');
		const active = new Set<string>();
		for (const owner of snapshot.extensions) {
			if (owner.lifecycle !== 'ready' || owner.incarnation === undefined) { continue; }
			for (const registration of owner.registrations) {
				if (registration.kind !== 'dataChannel' || registration.channelId !== 'canvas.provider.v1') { continue; }
				const extension = declarations.find(entry => entry.description.id === owner.id || entry.description.runtimeBinding?.runtimeId === owner.id && entry.description.runtimeBinding.packageDigest === owner.packageDigest);
				const key = JSON.stringify([owner.id, registration.registrationId]);
				active.add(key);
				const identity = JSON.stringify([owner.packageDigest, owner.incarnation, owner.activationGeneration]);
				const current = this.bindings.get(key);
				if (current?.identity === identity && current.settled !== false) { continue; }
				const previous = this.bindings.get(key)?.provider;
				if (previous) { this.canvases.suspendProvider(previous); this.suspended.add(owner.id); }
				this.registrations.deleteAndDispose(key);
				const lifetime = new DisposableStore();
				const controller = new AbortController();
				lifetime.add(toDisposable(() => controller.abort()));
				const source = { extensionId: owner.id, incarnation: owner.incarnation, activationGeneration: owner.activationGeneration };
				const binding: { identity: string; source: ExtensionClientSource; provider?: ICanvasProvider; settled?: boolean; } = { identity, source };
				this.bindings.set(key, binding);
				this.registrations.set(key, lifetime);
				const invoke = async (action: string, context: ICanvasOwner, instanceId: string, signal: AbortSignal) => {
					const result = await this.runtime.invoke({
						...source, registrationId: registration.registrationId, operation: 'receiveData', deadlineUnixMillis: Date.now() + this.timeout,
						payload: { data: { action, context: { sessionId: context.session.path.slice(1), threadId: context.chat.path.slice(1), instanceId } } },
					}, AbortSignal.any([signal, controller.signal]));
					if (!result || typeof result !== 'object' || Array.isArray(result)) { throw new TypeError('Invalid Canvas provider result'); }
					return result as Record<string, JsonValue>;
				};
				const loading = lifetime.add(this.canvases.beginDefinitionRefresh());
				void this.runtime.invoke({ ...source, registrationId: registration.registrationId, operation: 'receiveData', deadlineUnixMillis: Date.now() + this.timeout, payload: { data: { action: 'describe' } } }, controller.signal).then(result => {
					if (controller.signal.aborted || this.isDisposed) { return; }
					if (!result || typeof result !== 'object' || Array.isArray(result)) { throw new TypeError('Invalid Canvas definition'); }
					const declaration = result as Record<string, JsonValue>;
					if (declaration.state !== 'definition' || typeof declaration.canvasId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(declaration.canvasId) || typeof declaration.displayName !== 'string' || !declaration.displayName.trim() || declaration.displayName.length > 256 || typeof declaration.description !== 'string' || declaration.description.length > 4096 || typeof declaration.requiresInput !== 'boolean') { throw new TypeError('Invalid Canvas definition'); }
					const provider: ICanvasProvider = {
						definition: { canvasId: declaration.canvasId, extensionId: owner.id, extensionSource: extension?.description.sourceKind === 'plugin' ? 'plugin' : extension ? 'user' : 'unknown', extensionName: extension?.description.displayName, displayName: declaration.displayName, description: declaration.description, requiresInput: declaration.requiresInput },
						signal: controller.signal,
						open: async (context, instanceId, signal) => sourceResult(await invoke('open', context, instanceId, signal)),
						resolve: async (context, instanceId, signal) => {
							const result = await invoke('resolve', context, instanceId, signal);
							return result.state === 'closed' ? null : result.state === 'pending' ? undefined : result.state === 'unchanged' ? 'unchanged' : sourceResult(result);
						},
						close: async (context, instanceId, signal) => { await invoke('close', context, instanceId, signal); },
					};
					binding.provider = provider;
					lifetime.add(this.canvases.register(provider));
					binding.settled = true;
					void this.canvases.refreshProvider(provider).catch(error => { if (!controller.signal.aborted) { this.log.error('canvas', 'Could not hydrate a Canvas provider', error); } });
				}).catch(error => { binding.settled = false; if (!controller.signal.aborted) { this.log.error('canvas', 'Could not load a registered Canvas definition', error); } }).finally(() => {
					if (binding.settled || controller.signal.aborted) { loading.dispose(); }
					this.settleOwner(owner.id);
				});
			}
		}
		for (const key of this.registrations.keys()) {
			if (active.has(key)) { continue; }
			const binding = this.bindings.get(key);
			const owner = snapshot.extensions.find(owner => owner.id === binding?.source.extensionId);
			if (binding?.provider && owner && ['dormant', 'starting', 'handshaking', 'recovering', 'crashLoop', 'failed'].includes(owner.lifecycle)) {
				this.canvases.suspendProvider(binding.provider);
				this.suspended.add(owner.id);
			}
			this.registrations.deleteAndDispose(key); this.bindings.delete(key);
		}
		for (const extensionId of this.readyOwners) { this.settleOwner(extensionId); }
		this.canvases.reconcileExtensions(new Set(snapshot.extensions.filter(owner => owner.lifecycle !== 'stopped').map(owner => owner.id)));
	}

	private settleOwner(extensionId: string): void {
		if (!this.readyOwners.has(extensionId) || [...this.bindings.values()].some(binding => binding.source.extensionId === extensionId && !binding.settled)) { return; }
		this.canvases.settleExtension(extensionId);
		this.suspended.delete(extensionId);
	}

	async handleChange(payload: JsonValue, source: ExtensionClientSource): Promise<void> {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'canvasId,method' || !('canvasId' in payload) || typeof payload.canvasId !== 'string') { throw new TypeError('Invalid Canvas invalidation'); }
		const binding = [...this.bindings.values()].find(binding => binding.source.extensionId === source.extensionId && binding.provider?.definition.canvasId === payload.canvasId);
		if (!binding?.provider || binding.source.activationGeneration !== source.activationGeneration || binding.source.incarnation !== source.incarnation) { throw new Error('Canvas provider has retired'); }
		await this.canvases.refreshProvider(binding.provider);
	}

	clear(): void {
		this.readyOwners.clear();
		for (const binding of this.bindings.values()) {
			if (binding.provider) { this.canvases.suspendProvider(binding.provider); this.suspended.add(binding.source.extensionId); }
		}
		this.registrations.clearAndDisposeAll(); this.bindings.clear();
	}
}

function sourceResult(value: Record<string, JsonValue>): { url: string; title?: string; status?: string; } {
	if (value.state !== 'ready' || typeof value.url !== 'string' || value.url.length > 8192
		|| value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 256)
		|| value.status !== undefined && (typeof value.status !== 'string' || value.status.length > 4096)) { throw new TypeError('Invalid Canvas source'); }
	const url = normalizeBrowserViewUrl(value.url);
	if (url === 'about:blank') { throw new TypeError('Canvas requires an HTTP or HTTPS source'); }
	return { url, ...(value.title === undefined ? {} : { title: value.title as string }), ...(value.status === undefined ? {} : { status: value.status as string }) };
}
