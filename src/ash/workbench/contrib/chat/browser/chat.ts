import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** The live presentation owns the input; the registry never owns a conversation model. */
export interface IChatWidget {
	readonly domNode: HTMLElement;
	readonly visible: boolean;
	readonly inputEditor: ICodeEditor | undefined;
	readonly isTranscriptProgressActive: boolean;
	readonly onDidHide: Event<void>;
	readonly onDidChangeViewModel: Event<void>;
	startVoiceConversation(): Promise<void>;
}

export interface IChatWidgetService {
	/** Most recently focused, still registered and visible Chat in this window. */
	readonly lastFocusedWidget: IChatWidget | undefined;
	getAllWidgets(): readonly IChatWidget[];
	register(newWidget: IChatWidget): IDisposable;
}

export const IChatWidgetService = createServiceIdentifier<IChatWidgetService>('chatWidgetService');
