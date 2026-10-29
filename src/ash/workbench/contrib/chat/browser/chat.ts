import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';

/** The live presentation owns the input; the registry never owns a conversation model. */
export interface IChatWidget {
	readonly sessionId: string | undefined;
	readonly threadId: string | undefined;
	readonly domNode: HTMLElement;
	readonly visible: boolean;
	readonly onDidChangeVisibility: Event<void>;
	readonly inputEditor: ICodeEditor | undefined;
	readonly isTranscriptProgressActive: boolean;
	readonly onDidHide: Event<void>;
	readonly onDidChangeViewModel: Event<void>;
	startVoiceConversation(): Promise<void>;
}

export interface IChatWidgetService {
	readonly onDidChangeWidgets: Event<void>;
	/** Most recently focused, still registered and visible Chat in this window. */
	readonly lastFocusedWidget: IChatWidget | undefined;
	getAllWidgets(): readonly IChatWidget[];
	register(newWidget: IChatWidget): IDisposable;
}

export const IChatWidgetService = createServiceIdentifier<IChatWidgetService>('chatWidgetService');

/** The composer remains the owner of preparation; a target admits references to its input. */
export interface IChatPasteTarget {
	/** Canonical captures in this draft, without positional annotations. */
	readonly attachments: readonly ChatContextAttachment[];
	/** The same captures projected onto their current message ranges. */
	readonly inlineReferences: readonly ChatContextAttachment[];
	/** Return the accepted identities and positions for the pending draft snapshot. */
	addAttachments(entries: readonly ChatContextAttachment[], signal?: AbortSignal): readonly ChatContextAttachment[];
	removeAttachments(ids: readonly string[]): void;
	/** Bind a captured snapshot to reference text already inserted by an editor paste. */
	addInlineReference(reference: ChatContextAttachment): void;
}

export interface IChatPasteTargetService {
	registerTarget(inputUri: URI, target: IChatPasteTarget): IDisposable;
	getTarget(inputUri: URI): IChatPasteTarget | undefined;
}

export const IChatPasteTargetService = createServiceIdentifier<IChatPasteTargetService>('chatPasteTargetService');
