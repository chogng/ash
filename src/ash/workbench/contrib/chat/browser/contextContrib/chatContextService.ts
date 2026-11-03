import { CancellationToken, CancellationTokenSource, throwIfCancelled } from '../../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { score, type LanguageSelector } from '../../../../../editor/common/languageSelector.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import type { IChatContextItem, IChatExplicitContextProvider, IChatResourceContextProvider, IChatWorkspaceContextProvider } from '../../common/contextContrib/chatContext.js';
import type { IChatRequestWorkspaceVariableEntry, StringChatContextValue } from '../../common/attachments/chatVariableEntries.js';
import { IChatContextPickService, picksWithPromiseFn } from '../attachments/chatContextPickService.js';
import { localize } from '../../../../../nls.js';

export type ChatTabSelector = { uri: LanguageSelector; } | { viewType: string; };

export const IChatContextService = createServiceIdentifier<IChatContextService>('chatContextService');

export interface IChatContextService extends ChatContextService { }

interface Provider {
	readonly cancellation: CancellationTokenSource;
	picker?: { title: string; icon: ThemeIcon; };
	workspace?: IChatWorkspaceContextProvider;
	explicit?: IChatExplicitContextProvider;
	resource?: { selector: ChatTabSelector; provider: IChatResourceContextProvider; };
	workspaceItems: readonly IChatContextItem[];
}

/** Window registration owns live provider state; the existing composer owns accepted snapshots. */
export class ChatContextService extends Disposable {
	declare readonly _serviceBrand: undefined;
	private readonly providers = new Map<string, Provider>();
	private readonly lifetimes = this._register(new DisposableMap<string, DisposableStore>());
	private readonly pickers = this._register(new DisposableMap<string>());
	private readonly origins = new WeakMap<StringChatContextValue, { id: string; owner: Provider; item: IChatContextItem; }>();
	private executeCommand: ((handle: number) => Promise<void>) | undefined;

	constructor(
		@IChatContextPickService private readonly contextPicks: IChatContextPickService,
		@IExtensionService private readonly extensions: IExtensionService,
	) { super(); }

	public setExecuteCommandCallback(callback: (itemHandle: number) => Promise<void>): void {
		this.executeCommand = callback;
	}

	public async executeChatContextItemCommand(handle: number): Promise<void> {
		this.assertNotDisposed();
		await this.executeCommand?.(handle);
	}

	public setChatContextProvider(id: string, picker: { title: string; icon: ThemeIcon; }): void {
		const owner = this.provider(id);
		if (owner.picker?.title === picker.title && ThemeIcon.isEqual(owner.picker.icon, picker.icon) && this.pickers.has(id)) return;
		owner.picker = picker;
		this.pickers.set(id, this.contextPicks.registerChatContextItem({
			type: 'pickerPick', label: picker.title, icon: picker.icon,
			asPicker: () => ({
				placeholder: localize('chat.context.select', 'Select {0}', picker.title),
				picks: picksWithPromiseFn(async (query, token) => {
					throwIfCancelled(token);
					if (!this.providers.get(id)?.explicit) {
						const activation = new AbortController();
						using cancelled = token.onCancellationRequested(() => activation.abort());
						await raceCancellationError(this.extensions.activateByEvent(`onChatContextProvider:${id}`, activation.signal), token);
					}
					const current = this.providers.get(id);
					if (!current?.explicit) return [];
					using request = new CancellationTokenSource(current.cancellation.token);
					using listener = token.onCancellationRequested(() => request.cancel());
					if (token.isCancellationRequested) request.cancel();
					const items = await raceCancellationError(current.explicit.provideChatContext(request.token), request.token);
					this.assertCurrent(id, current, request.token);
					const filter = query.toLocaleLowerCase();
					return items.filter(item => this.label(item).toLocaleLowerCase().includes(filter)).map(item => ({
						label: this.label(item), description: item.modelDescription,
						iconClasses: ThemeIcon.isThemeIcon(item.iconPath) ? ThemeIcon.asClassNameArray(item.iconPath) : undefined,
						asAttachment: async () => {
							this.assertCurrent(id, current, token);
							using resolution = new CancellationTokenSource(current.cancellation.token);
							using cancelled = token.onCancellationRequested(() => resolution.cancel());
							const resolved = item.value === undefined ? await raceCancellationError(current.explicit!.resolveChatContext(item, resolution.token), resolution.token) : item;
							this.assertCurrent(id, current, resolution.token);
							return this.attachment(id, resolved);
						},
					}));
				}),
			}),
		}));
	}

	public registerChatWorkspaceContextProvider(id: string, provider: IChatWorkspaceContextProvider): void {
		this.provider(id).workspace = provider;
	}

	public registerChatExplicitContextProvider(id: string, provider: IChatExplicitContextProvider): void {
		this.provider(id).explicit = provider;
	}

	public registerChatResourceContextProvider(id: string, selector: ChatTabSelector, provider: IChatResourceContextProvider): void {
		this.provider(id).resource = { selector, provider };
	}

	public unregisterChatContextProvider(id: string): void {
		const owner = this.providers.get(id);
		if (owner) {
			owner.explicit = undefined;
			owner.resource = undefined;
			owner.workspace = undefined;
			owner.workspaceItems = [];
			owner.picker = undefined;
		}
		this.providers.delete(id);
		this.pickers.deleteAndDispose(id);
		this.lifetimes.deleteAndDispose(id);
	}

	public updateWorkspaceContextItems(id: string, items: IChatContextItem[]): void {
		const owner = this.providers.get(id);
		if (owner?.workspace) owner.workspaceItems = items.map(item => ({ ...item }));
	}

	public getWorkspaceContextItems(): IChatRequestWorkspaceVariableEntry[] {
		this.assertNotDisposed();
		return [...this.providers].flatMap(([id, owner]) => owner.workspaceItems.filter(item => item.value !== undefined).map(item => ({
			id: `${id}:${item.handle}`, name: this.label(item), kind: 'workspace' as const,
			value: item.value!, modelDescription: item.modelDescription,
		})));
	}

	public async contextForResource(uri: URI, language?: string, viewType?: string, token: CancellationToken = CancellationToken.None): Promise<StringChatContextValue | undefined> {
		this.assertNotDisposed();
		const matches = [...this.providers].map(([id, owner]) => {
			const selector = owner.resource?.selector;
			let relevance = 0;
			if (selector && 'viewType' in selector) relevance = selector.viewType === viewType ? 10 : 0;
			else if (selector) relevance = score(selector.uri, uri, language ?? '', true, undefined, undefined);
			return { id, owner, relevance };
		}).filter(match => match.relevance > 0).sort((a, b) => b.relevance - a.relevance);
		for (const { id, owner } of matches) {
			using request = new CancellationTokenSource(owner.cancellation.token);
			using listener = token.onCancellationRequested(() => request.cancel());
			if (token.isCancellationRequested) request.cancel();
			throwIfCancelled(request.token);
			const item = await raceCancellationError(owner.resource!.provider.provideChatContext(uri, false, viewType, request.token), request.token);
			this.assertCurrent(id, owner, request.token);
			if (!item) continue;
			const context: StringChatContextValue = {
				uri, resourceUri: item.resourceUri, value: item.value, name: this.label(item),
				modelDescription: item.modelDescription, iconPath: item.iconPath, tooltip: item.tooltip,
				commandId: item.command?.id, handle: item.handle,
			};
			this.origins.set(context, { id, owner, item });
			return context;
		}
		return undefined;
	}

	public async resolveChatContext(context: StringChatContextValue, _language?: string, token: CancellationToken = CancellationToken.None): Promise<StringChatContextValue> {
		const origin = this.origins.get(context);
		if (!origin) throw new CancellationError();
		const { id, owner, item } = origin;
		this.assertCurrent(id, owner, token);
		if (context.value !== undefined) return context;
		using request = new CancellationTokenSource(owner.cancellation.token);
		using listener = token.onCancellationRequested(() => request.cancel());
		const resolved = await raceCancellationError(owner.resource!.provider.resolveChatContext(item, request.token), request.token);
		this.assertCurrent(id, owner, request.token);
		const result: StringChatContextValue = {
			...context, value: resolved.value, name: this.label(resolved), resourceUri: resolved.resourceUri,
			iconPath: resolved.iconPath, tooltip: resolved.tooltip, modelDescription: resolved.modelDescription,
			commandId: resolved.command?.id, handle: resolved.handle,
		};
		this.origins.set(result, { id, owner, item: resolved });
		return result;
	}

	private provider(id: string): Provider {
		this.assertNotDisposed();
		let owner = this.providers.get(id);
		if (!owner) {
			const cancellation = new CancellationTokenSource();
			const lifetime = new DisposableStore();
			lifetime.add(toDisposable(() => cancellation.dispose(true)));
			owner = { cancellation, workspaceItems: [] };
			this.providers.set(id, owner);
			this.lifetimes.set(id, lifetime);
		}
		return owner;
	}

	private assertCurrent(id: string, owner: Provider, token: CancellationToken): void {
		throwIfCancelled(token);
		if (this.isDisposed || this.providers.get(id) !== owner) throw new CancellationError();
	}

	private label(item: IChatContextItem): string {
		return item.label ?? (item.resourceUri ? basename(item.resourceUri) : localize('chat.context.unnamed', 'Context item'));
	}

	private attachment(id: string, item: IChatContextItem): ChatContextAttachment {
		if (item.value === undefined) throw new Error(localize('chat.context.providerNoContent', 'The context provider did not return any content.'));
		const name = this.label(item);
		const content = item.modelDescription ? `${item.modelDescription}\n\n${item.value}` : item.value;
		const owner = this.providers.get(id);
		return {
			id: `${id}:${item.handle}`, kind: 'generic', name, resource: item.resourceUri,
			iconPath: item.iconPath, tooltip: item.tooltip,
			open: item.command ? async () => {
				if (!owner) throw new CancellationError();
				this.assertCurrent(id, owner, owner.cancellation.token);
				await this.executeChatContextItemCommand(item.handle);
			} : undefined,
			resolve: async () => ({ name, content }),
		};
	}

	protected override disposeCore(): void {
		for (const id of this.providers.keys()) this.unregisterChatContextProvider(id);
		this.executeCommand = undefined;
		super.disposeCore();
	}
}
