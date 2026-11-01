import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

export namespace ChatContextKeys {
	/** The window's Chat implementation is available and its UI preference permits use. */
	export const enabled = new RawContextKey<boolean>('chatIsEnabled', false);
	export const hasActiveRequest = new RawContextKey<boolean>('chatSessionHasActiveRequest', false);
	export const inChatSession = new RawContextKey<boolean>('inChat', false);
	export const inputCursorAtTop = new RawContextKey<boolean>('chatCursorAtTop', false);
	export const inChatInput = new RawContextKey<boolean>('inChatInput', false);
	export const inQuickChat = new RawContextKey<boolean>('quickChatHasFocus', false);
	export const findSupported = new RawContextKey<boolean>('chatFindSupported', false);
	export const findWidgetVisible = new RawContextKey<boolean>('chatFindWidgetVisible', false);
	export const findWidgetFocused = new RawContextKey<boolean>('chatFindWidgetFocused', false);
	export const findInputFocused = new RawContextKey<boolean>('chatFindInputFocused', false);
	/** Projects the Chat view's actual layout, independently of list visibility. */
	export const agentSessionsViewerOrientation = new RawContextKey<number | undefined>('agentSessionsViewerOrientation', undefined);
}
