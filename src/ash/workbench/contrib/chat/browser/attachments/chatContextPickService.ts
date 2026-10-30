import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorunWithStore, constObservable, observableValue, type IObservable } from '../../../../../base/common/observable.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import type { IChatWidget } from '../chat.js';

export interface IChatContextPickerPickItem extends IQuickPickItem {
	readonly iconClasses?: readonly string[];
	readonly disabled?: boolean;
	asAttachment(): ChatContextPickAttachment | Promise<ChatContextPickAttachment>;
}

export type ChatContextPickAttachment = ChatContextAttachment | ChatContextAttachment[] | 'noop';

export function isChatContextPickerPickItem(item: unknown): item is IChatContextPickerPickItem {
	return typeof item === 'object' && item !== null && 'asAttachment' in item && typeof item.asAttachment === 'function';
}

interface IChatContextItem {
	readonly label: string;
	readonly icon: Icon;
	readonly commandId?: string;
	readonly ordinal?: number;
	/** Places an action beside the built-in sources in Add context. */
	readonly presentation?: 'inline';
	// New Chat can own a composer before a transcript widget exists.
	isEnabled?(widget?: IChatWidget): boolean | Promise<boolean>;
}

export interface IChatContextValueItem extends IChatContextItem {
	readonly type: 'valuePick';
	asAttachment(widget?: IChatWidget, signal?: AbortSignal): Promise<ChatContextAttachment | ChatContextAttachment[] | undefined>;
}

export type ChatContextPick = IChatContextPickerPickItem | IQuickPickSeparator;

export interface IChatContextPicker {
	readonly placeholder: string;
	readonly picks: Promise<ChatContextPick[]> | ((query: IObservable<string>, token: CancellationToken) => IObservable<{ busy: boolean; picks: ChatContextPick[]; error?: unknown; }>);
	readonly goBack?: () => boolean;
	readonly configure?: { readonly label: string; readonly commandId: string; };
	readonly dispose?: () => void;
}

export interface IChatContextPickerItem extends IChatContextItem {
	readonly type: 'pickerPick';
	asPicker(widget?: IChatWidget): IChatContextPicker;
}

/** Gives a query one cancellable acquisition; only its current result can replace the displayed choices. */
export function picksWithPromiseFn(fn: (query: string, token: CancellationToken) => Promise<ChatContextPick[]>): (query: IObservable<string>, token: CancellationToken) => IObservable<{ busy: boolean; picks: ChatContextPick[]; error?: unknown; }> {
	return (query, token) => {
		if (token.isCancellationRequested) return constObservable({ busy: false, picks: [] });
		const result = observableValue<{ busy: boolean; picks: ChatContextPick[]; error?: unknown; }>('chatContextPicks', { busy: true, picks: [] });
		const lifetime = new DisposableStore();
		lifetime.add(autorunWithStore((reader, store) => {
			const value = query.read(reader);
			const request = new CancellationTokenSource(token);
			store.add(toDisposable(() => request.dispose(true)));
			result.set({ busy: true, picks: [] });
			void Promise.resolve().then(() => request.token.isCancellationRequested ? [] : fn(value, request.token)).then(picks => {
				if (!request.token.isCancellationRequested) result.set({ busy: false, picks });
			}, error => {
				if (!request.token.isCancellationRequested) result.set({ busy: false, picks: [], error });
			});
		}));
		lifetime.add(token.onCancellationRequested(() => lifetime.dispose()));
		return result;
	};
}

export interface IChatContextPickService {
	readonly _serviceBrand: undefined;
	readonly items: Iterable<IChatContextValueItem | IChatContextPickerItem>;
	registerChatContextItem(item: IChatContextValueItem | IChatContextPickerItem): IDisposable;
}

export const IChatContextPickService = createServiceIdentifier<IChatContextPickService>('chatContextPickService');

/** Window-local registration only. The originating Add context action owns picker UI and admission. */
export class ChatContextPickService implements IChatContextPickService {
	declare readonly _serviceBrand: undefined;
	private readonly registrations = new Set<IChatContextValueItem | IChatContextPickerItem>();

	get items(): readonly (IChatContextValueItem | IChatContextPickerItem)[] {
		return [...this.registrations].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0) || a.label.localeCompare(b.label));
	}

	registerChatContextItem(item: IChatContextValueItem | IChatContextPickerItem): IDisposable {
		if (this.registrations.has(item)) throw new Error('Chat context item is already registered');
		this.registrations.add(item);
		return toDisposable(() => this.registrations.delete(item));
	}
}
