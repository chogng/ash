import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

export interface ResolvedChatContext {
	readonly name: string;
	readonly content: string;
}

export interface ChatContextAttachment {
	readonly id: string;
	readonly kind: string;
	readonly name: string;
	resolve(): Promise<ResolvedChatContext>;
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
	registerPicker(picker: ChatContextPicker): IDisposable;
	pickContext(quickInputService: IQuickInputService): Promise<ChatContextAttachment | undefined>;
}

export const IChatContextPickService = createServiceIdentifier<IChatContextPickService>('chatContextPickService');
