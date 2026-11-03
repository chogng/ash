import { CancellationToken, throwIfCancelled } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import type { LanguageSelector } from '../../../editor/common/languageSelector.js';
import { IExtensionHostApi, type ExtensionClientSource, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/extensions/common/extensionHostApi.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IExtensionService, type ExtensionManifest } from '../../services/extensions/common/extensionService.js';
import { IChatContextService, type ChatTabSelector } from '../../contrib/chat/browser/contextContrib/chatContextService.js';
import type { IChatContextItem } from '../../contrib/chat/common/contextContrib/chatContext.js';

interface Binding {
	readonly source: ExtensionClientSource;
	readonly registrationId: string;
	readonly identity: string;
	readonly controller: AbortController;
	readonly handles: Map<number, number>;
	id?: string;
	kind?: 'workspace' | 'explicit' | 'resource';
	ready?: Promise<void>;
	refresh?: AbortController;
}

/** Converts the admitted chat.context.v1 channel to domain providers and owns incarnation cancellation. */
export class MainThreadChatContext extends Disposable {
	private readonly bindings = new Map<string, Binding>();
	private readonly lifetimes = this._register(new DisposableMap<string, DisposableStore>());
	private readonly commands = new Map<number, { binding: Binding; remoteHandle: number; }>();
	private nextHandle = 0;

	constructor(
		private readonly timeout: number,
		@IExtensionHostApi private readonly runtime: IExtensionHostApi,
		@IExtensionService private readonly extensions: IExtensionService,
		@IChatContextService private readonly contexts: IChatContextService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		contexts.setExecuteCommandCallback(async handle => {
			const command = this.commands.get(handle);
			if (!command) throw new CancellationError();
			await this.invoke(command.binding, { action: 'execute', handle: command.remoteHandle });
		});
	}

	public async update(snapshot: ExtensionHostFleetSnapshot): Promise<void> {
		const active = new Set<string>();
		const loading: Promise<void>[] = [];
		const declarations = this.extensions.getExtensionPointContributions<ExtensionManifest['contributes']['chatContext']>('chatContext');
		for (const owner of snapshot.extensions) {
			if (owner.lifecycle !== 'ready' || owner.incarnation === undefined) continue;
			for (const registration of owner.registrations) {
				if (registration.kind !== 'dataChannel' || registration.channelId !== 'chat.context.v1') continue;
				const key = JSON.stringify([owner.id, registration.registrationId]);
				active.add(key);
				const declaration = declarations.find(item => item.description.id === owner.id
					|| item.description.runtimeBinding?.runtimeId === owner.id && item.description.runtimeBinding.packageDigest === owner.packageDigest);
				const identity = JSON.stringify([owner.packageDigest, owner.incarnation, owner.activationGeneration, declaration?.value]);
				const existing = this.bindings.get(key);
				if (existing?.identity === identity) {
					// Activation and fleet notifications can publish the same snapshot concurrently.
					// Both callers must wait until its descriptor has installed the domain provider.
					if (existing.ready) loading.push(existing.ready);
					continue;
				}
				this.lifetimes.deleteAndDispose(key);
				const lifetime = new DisposableStore();
				const binding: Binding = {
					identity, registrationId: registration.registrationId,
					source: { extensionId: owner.id, incarnation: owner.incarnation, activationGeneration: owner.activationGeneration },
					controller: new AbortController(), handles: new Map(),
				};
				this.bindings.set(key, binding);
				this.lifetimes.set(key, lifetime);
				lifetime.add(toDisposable(() => {
					binding.controller.abort();
					binding.refresh?.abort();
					if (binding.id) this.contexts.unregisterChatContextProvider(binding.id);
					for (const handle of binding.handles.values()) this.commands.delete(handle);
					binding.handles.clear();
					if (this.bindings.get(key) === binding) this.bindings.delete(key);
				}));
				binding.ready = (async () => {
					const definition = record(await this.invoke(binding, { action: 'describe' }));
					const id = text(definition.id, 128);
					if (!/^[A-Za-z0-9._-]+$/.test(id)) throw invalid('provider.id');
					const providerId = `${declaration?.description.id ?? owner.id}:${id}`;
					if ([...this.bindings.values()].some(other => other !== binding && other.id === providerId)) throw invalid('provider.id');
					binding.id = providerId;
					if (definition.kind === 'workspace') {
						binding.kind = 'workspace';
						this.contexts.registerChatWorkspaceContextProvider(binding.id, {
							provideWorkspaceChatContext: token => this.items(binding, token),
						});
						// Descriptors finish activation. Workspace reads can call other extensions and refresh independently.
						void this.refreshWorkspace(binding).catch(error => {
							if (!binding.controller.signal.aborted) this.log.error('chatContext', 'Could not refresh workspace context', error);
						});
					} else if (definition.kind === 'explicit') {
						const item = declaration?.value.find(item => item.id === id);
						if (!item) throw invalid('contributes.chatContext');
						binding.kind = 'explicit';
						this.contexts.setChatContextProvider(binding.id, { title: item.displayName, icon: ThemeIcon.fromString(item.icon)! });
						this.contexts.registerChatExplicitContextProvider(binding.id, {
							provideChatContext: token => this.items(binding, token),
							resolveChatContext: (item, token) => this.resolve(binding, item, token),
						});
					} else if (definition.kind === 'resource') {
						binding.kind = 'resource';
						this.contexts.registerChatResourceContextProvider(binding.id, selector(definition.selector), {
							provideChatContext: async (resource, withValue, viewType, token) => {
								const item = await this.invoke(binding, { action: 'provide', resource: resource.toString(), withValue, viewType: viewType ?? null }, token);
								return item === null ? undefined : this.item(binding, item);
							},
							resolveChatContext: (item, token) => this.resolve(binding, item, token),
						});
					} else throw invalid('provider.kind');
				})().catch(error => {
					if (!binding.controller.signal.aborted) {
						this.log.error('chatContext', 'Could not register a chat context provider', error);
						this.lifetimes.deleteAndDispose(key);
					}
				});
				loading.push(binding.ready);
			}
		}
		for (const key of this.lifetimes.keys()) if (!active.has(key)) this.lifetimes.deleteAndDispose(key);
		for (const declaration of declarations) {
			const owner = snapshot.extensions.find(owner => owner.id === declaration.description.id
				|| declaration.description.runtimeBinding?.runtimeId === owner.id && declaration.description.runtimeBinding.packageDigest === owner.packageDigest);
			if (!owner || owner.lifecycle !== 'ready' && owner.lifecycle !== 'dormant') continue;
			for (const item of declaration.value) {
				this.contexts.setChatContextProvider(`${declaration.description.id}:${item.id}`, {
					title: item.displayName, icon: ThemeIcon.fromString(item.icon)!,
				});
			}
		}
		await Promise.all(loading);
	}

	public async handleChange(payload: JsonValue, source: ExtensionClientSource): Promise<void> {
		const request = record(payload);
		if (Object.keys(request).sort().join(',') !== 'method,registrationId' || request.method !== 'chatContextChanged') throw invalid('chatContextChanged');
		const key = JSON.stringify([source.extensionId, text(request.registrationId, 256)]);
		const binding = this.bindings.get(key);
		if (!binding || binding.kind !== 'workspace'
			|| binding.source.incarnation !== source.incarnation
			|| binding.source.activationGeneration !== source.activationGeneration) throw new CancellationError();
		await this.refreshWorkspace(binding);
	}

	public clear(): void {
		this.lifetimes.clearAndDisposeAll();
		this.commands.clear();
	}

	private async invoke(binding: Binding, data: JsonValue, token: CancellationToken = CancellationToken.None): Promise<JsonValue> {
		throwIfCancelled(token);
		const controller = new AbortController();
		using cancelled = token.onCancellationRequested(() => controller.abort());
		const signal = AbortSignal.any([binding.controller.signal, controller.signal]);
		throwIfCancelled(signal);
		const result = await this.runtime.invoke({
			...binding.source, registrationId: binding.registrationId, operation: 'receiveData',
			payload: { data }, deadlineUnixMillis: Date.now() + this.timeout,
		}, signal);
		throwIfCancelled(signal);
		return result;
	}

	private async items(binding: Binding, token: CancellationToken): Promise<IChatContextItem[]> {
		const result = await this.invoke(binding, { action: 'provide' }, token);
		if (!Array.isArray(result) || result.length > 512) throw invalid('items');
		return result.map(item => this.item(binding, item));
	}

	private async resolve(binding: Binding, item: IChatContextItem, token: CancellationToken): Promise<IChatContextItem> {
		const source = this.commands.get(item.handle);
		if (source?.binding !== binding) throw new CancellationError();
		const resolved = record(await this.invoke(binding, { action: 'resolve', handle: source.remoteHandle }, token));
		if (resolved.handle !== source.remoteHandle) throw invalid('item.handle');
		return this.item(binding, resolved);
	}

	private async refreshWorkspace(binding: Binding): Promise<void> {
		binding.refresh?.abort();
		const refresh = binding.refresh = new AbortController();
		const cancellation = {
			get isCancellationRequested(): boolean { return refresh.signal.aborted; },
			onCancellationRequested: (listener: () => unknown) => {
				refresh.signal.addEventListener('abort', listener, { once: true });
				return toDisposable(() => refresh.signal.removeEventListener('abort', listener));
			},
		};
		try {
			const items = await this.items(binding, cancellation);
			if (!refresh.signal.aborted && binding.id) this.contexts.updateWorkspaceContextItems(binding.id, items);
		} catch (error) {
			if (!refresh.signal.aborted && !binding.controller.signal.aborted) throw error;
		}
	}

	private item(binding: Binding, value: JsonValue): IChatContextItem {
		const source = record(value);
		if (!Number.isSafeInteger(source.handle) || (source.handle as number) < 1) throw invalid('item.handle');
		const remoteHandle = source.handle as number;
		let handle = binding.handles.get(remoteHandle);
		if (handle === undefined) {
			if (binding.handles.size >= 4096) {
				const first = binding.handles.entries().next().value!;
				binding.handles.delete(first[0]);
				this.commands.delete(first[1]);
			}
			handle = ++this.nextHandle;
			binding.handles.set(remoteHandle, handle);
			this.commands.set(handle, { binding, remoteHandle });
		}
		const item: IChatContextItem = { handle };
		for (const [key, limit] of [['label', 4096], ['value', 1024 * 1024], ['modelDescription', 16384]] as const) {
			if (source[key] !== undefined) item[key] = text(source[key], limit, { allowEmpty: true });
		}
		if (source.resourceUri !== undefined) item.resourceUri = URI.parse(text(source.resourceUri, 8192));
		if (source.tooltip !== undefined) item.tooltip = { value: text(record(source.tooltip).value, 16384, { allowEmpty: true }) };
		if (source.iconPath !== undefined) {
			if (typeof source.iconPath === 'string') item.iconPath = URI.parse(text(source.iconPath, 8192));
			else {
				const icon = record(source.iconPath);
				if (typeof icon.id === 'string' && /^[A-Za-z0-9-]+(?:~[A-Za-z]+)?$/.test(icon.id)) item.iconPath = { id: icon.id };
				else item.iconPath = { light: URI.parse(text(icon.light, 8192)), dark: URI.parse(text(icon.dark, 8192)) };
			}
		}
		if (source.command !== undefined) item.command = { id: text(record(source.command).id, 256) };
		return item;
	}
}

function record(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('object');
	return value as Record<string, JsonValue>;
}

function text(value: JsonValue | undefined, limit: number, options: { readonly allowEmpty?: boolean; } = {}): string {
	if (typeof value !== 'string' || !options.allowEmpty && !value.trim() || value.length > limit || value.includes('\0')) throw invalid('text');
	return value;
}

function selector(value: JsonValue | undefined): ChatTabSelector {
	const input = record(value ?? null);
	if (Object.keys(input).length !== 1) throw invalid('provider.selector');
	if (input.viewType !== undefined) return { viewType: text(input.viewType, 256) };
	const parse = (value: JsonValue): LanguageSelector => {
		if (typeof value === 'string') return text(value, 256);
		if (Array.isArray(value)) {
			if (value.length === 0 || value.length > 64 || value.some(Array.isArray)) throw invalid('provider.selector');
			return value.map(entry => parse(entry)) as LanguageSelector;
		}
		const filter = record(value);
		if (Object.keys(filter).length === 0 || Object.keys(filter).some(key => !['scheme', 'language', 'pattern'].includes(key))) throw invalid('provider.selector');
		return Object.fromEntries(Object.entries(filter).map(([key, entry]) => [key, text(entry, 4096)]));
	};
	return { uri: parse(input.uri ?? null) };
}

function invalid(field: string): TypeError {
	return new TypeError(localize('chat.context.invalidProviderData', 'The context provider returned invalid data for {0}.', field));
}
