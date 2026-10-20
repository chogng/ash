import type { URI } from '../../../../base/common/uri.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { ITerminalOutputSnapshot } from '../../../../platform/terminal/common/terminal.js';

export interface ResolvedChatContext {
	readonly name: string;
	readonly content: string;
	/** Images hold a URL; instructions hold an authorized backend path; tool selections hold a JSON array of disabled names. */
	readonly kind?: 'image' | 'instruction' | 'toolSelection';
}

export interface ChatContextAttachment {
	/** Source-owned context stays until its producer closes or the user removes it. */
	readonly lifetime?: 'submission' | 'source';
	readonly terminalSnapshot?: ITerminalOutputSnapshot;
	readonly id: string;
	readonly kind: string;
	/** Original source; the resolved content remains the selected snapshot. */
	readonly resource?: URI;
	readonly name: string;
	/** Position of the visible reference in the message; older saved drafts may omit it. */
	readonly reference?: { readonly start: number; readonly end: number; };
	resolve(): Promise<ResolvedChatContext>;
}

/** A Chat view that accepts context from another Workbench contribution. */
export interface IChatContextTarget {
	addContext(attachment: ChatContextAttachment): void;
	/** Appends to the currently visible composer synchronously, preserving its draft and attachments. */
	appendToDraft(text: string): void;
	/** Captures and previews an image through the active composer’s attachment lifecycle. */
	captureScreenshot(): Promise<void>;
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
