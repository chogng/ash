import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { InstructionReference } from '../../../../platform/instructions/common/instructionApi.js';

export interface ResolvedChatContext {
	readonly name: string;
	readonly content: string;
	readonly filePath?: string;
}

export interface ResolvedInstructionAttachment {
	readonly type: 'instruction';
	readonly reference: InstructionReference;
}

export type ResolvedChatAttachment = ResolvedChatContext | ResolvedInstructionAttachment;

export interface ChatContextAttachment<T extends ResolvedChatAttachment = ResolvedChatContext> {
	readonly id: string;
	readonly kind: string;
	readonly name: string;
	resolve(): Promise<T>;
}

export interface ChatContextPick<T extends ResolvedChatAttachment = ResolvedChatContext> {
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	readonly attachment: ChatContextAttachment<T>;
}

export interface ChatContextPicker<T extends ResolvedChatAttachment = ResolvedChatContext> {
	readonly id: string;
	readonly label: string;
	isEnabled(): boolean | Promise<boolean>;
	providePicks(query: string): Promise<readonly ChatContextPick<T>[]>;
}

/** Registry and searchable selector for Chat context providers. */
export interface IChatContextPickService {
	registerPicker(picker: ChatContextPicker<ResolvedChatAttachment>): IDisposable;
	pickContext(quickInputService: IQuickInputService): Promise<ChatContextAttachment<ResolvedChatAttachment> | undefined>;
}

export const IChatContextPickService = createServiceIdentifier<IChatContextPickService>('chatContextPickService');
