import type { URI } from '../../../../base/common/uri.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

export interface ResolvedChatContext {
	readonly name: string;
	readonly content: string;
	/** Images hold a URL; instructions hold an authorized backend catalog path. */
	readonly kind?: 'image' | 'instruction';
}

export interface ChatContextAttachment {
	readonly id: string;
	readonly kind: string;
	/** Original source; the resolved content remains the selected snapshot. */
	readonly resource?: URI;
	readonly name: string;
	resolve(): Promise<ResolvedChatContext>;
}

/** A Chat view that accepts context from another Workbench contribution. */
export interface IChatContextTarget {
	addContext(attachment: ChatContextAttachment): void;
	acceptInput(value?: string): Promise<void>;
}

export interface ChatContextPick {
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	readonly attachment: ChatContextAttachment;
}

export interface ChatContextPicker {
	readonly id: string;
	readonly label: string;
	isEnabled(): boolean | Promise<boolean>;
	providePicks(query: string): Promise<readonly ChatContextPick[]>;
}

/** Registry and searchable selector for Chat context providers. */
export interface IChatContextPickService {
	readonly items: readonly ChatContextPicker[];
	registerPicker(picker: ChatContextPicker): IDisposable;
	pickContext(quickInputService: IQuickInputService, signal?: AbortSignal): Promise<ChatContextAttachment | undefined>;
}

export const IChatContextPickService = createServiceIdentifier<IChatContextPickService>('chatContextPickService');
