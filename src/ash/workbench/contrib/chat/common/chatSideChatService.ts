import { localize } from '../../../../nls.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';

export interface IChatSideChatSelection { readonly text: string; }

export interface IChatSideChatOrigin {
	readonly sourceSessionResource: URI;
	readonly sourceTurnId: string;
	readonly sourceTitle: string | undefined;
	readonly selection?: IChatSideChatSelection;
}

export interface IChatSideChatRequestOptions {
	readonly attachedContext?: readonly ChatContextAttachment[];
	readonly token?: CancellationToken;
	readonly sourceTurnId?: string;
	readonly signal?: AbortSignal;
}

export interface IChatSideChatProvider {
	canAskInSideChat(sessionResource: URI): boolean;
	askInSideChat(sessionResource: URI, query: string, selection?: IChatSideChatSelection, options?: IChatSideChatRequestOptions): Promise<void>;
	observeSideChatOrigin(sessionResource: URI): IObservable<IChatSideChatOrigin | undefined>;
	revealSideChatSource(sessionResource: URI): Promise<void>;
}

export const IChatSideChatService = createDecorator<IChatSideChatService>('chatSideChatService');

export interface IChatSideChatService extends IChatSideChatProvider {
	registerProvider(provider: IChatSideChatProvider): IDisposable;
}

/** Hosts provide navigation and execution; this registry owns only provider lifetimes. */
export class ChatSideChatService extends Disposable implements IChatSideChatService {
	private readonly providers = observableValue<readonly IChatSideChatProvider[]>(this, []);

	registerProvider(provider: IChatSideChatProvider): IDisposable {
		this.assertNotDisposed();
		if (this.providers.get().includes(provider)) throw new Error('Side chat provider is already registered');
		this.providers.set([...this.providers.get(), provider]);
		return toDisposable(() => this.providers.set(this.providers.get().filter(candidate => candidate !== provider)));
	}

	canAskInSideChat(resource: URI): boolean { return this.providers.get().some(provider => provider.canAskInSideChat(resource)); }

	async askInSideChat(resource: URI, query: string, selection?: IChatSideChatSelection, options?: IChatSideChatRequestOptions): Promise<void> {
		const provider = this.providers.get().find(provider => provider.canAskInSideChat(resource));
		if (!provider) throw new Error(localize('chat.btw.unavailable', 'Send a message in this conversation before starting a side chat.'));
		await provider.askInSideChat(resource, query, selection, options);
	}

	observeSideChatOrigin(resource: URI): IObservable<IChatSideChatOrigin | undefined> {
		return derived(reader => {
			for (const provider of this.providers.read(reader)) {
				const origin = provider.observeSideChatOrigin(resource).read(reader);
				if (origin) return origin;
			}
			return undefined;
		});
	}

	async revealSideChatSource(resource: URI): Promise<void> {
		const provider = this.providers.get().find(provider => provider.observeSideChatOrigin(resource).get() !== undefined);
		await provider?.revealSideChatSource(resource);
	}

	protected override disposeCore(): void {
		this.providers.set([]);
		super.disposeCore();
	}
}
