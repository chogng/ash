import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputNoticeHost, pickActiveChatInput, trackChatInputRecency, type IChatInputSurface } from './chatInputNoticeHost.js';

export const IChatInputNoticeHubService = createDecorator<IChatInputNoticeHubService>('chatInputNoticeHubService');

export interface IChatInputNoticeHubService {
	readonly _serviceBrand: undefined;
	registerHost(host: ChatInputNoticeHost, focusRoot: HTMLElement): IDisposable;
	toggleNoticeFocus(): boolean;
}

/** Resolves notice commands across retained panel, editor and Sessions inputs in this window. */
export class ChatInputNoticeHubService extends Disposable implements IChatInputNoticeHubService {
	readonly _serviceBrand = undefined;
	private readonly hosts = new Set<IChatInputSurface & { readonly host: ChatInputNoticeHost; }>();
	private readonly registrations = this._register(new DisposableMap<IChatInputSurface>());

	registerHost(host: ChatInputNoticeHost, focusRoot: HTMLElement): IDisposable {
		const surface = { host, focusRoot, lastFocused: 0 };
		const registration = new DisposableStore();
		this.hosts.add(surface);
		registration.add(trackChatInputRecency(surface));
		registration.add(toDisposable(() => this.hosts.delete(surface)));
		this.registrations.set(surface, registration);
		return toDisposable(() => this.registrations.deleteAndDispose(surface));
	}

	toggleNoticeFocus(): boolean {
		return pickActiveChatInput(this.hosts, surface => surface.host.hasFocusableNotice())?.host.toggleFocus() ?? false;
	}
}
