import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

// Navigation history belongs to the Sessions service; these keys only expose it to action conditions.
export const CanGoBackContext = new RawContextKey<boolean>('sessionsCanGoBack', false);
export const CanGoForwardContext = new RawContextKey<boolean>('sessionsCanGoForward', false);
/** The product workspace owning the current page and its sidebar navigation. */
export const SessionsWorkspaceModeContext = new RawContextKey<'chat' | 'code'>('sessions.workspaceMode', 'chat');

/** The navigation action whose context menu is being resolved. */
export const ActivityBarItemContext = new RawContextKey<string>('sessions.activityBar.actionId', '');

/** Describes the row that opened a Sessions context menu. */
export const SessionsMenuActiveConversationContext = new RawContextKey<boolean>('sessions.menu.activeConversation', false);

/** An empty local draft is visible in the conversation area. */
export const NewSessionDraftVisibleContext = new RawContextKey<boolean>('sessions.activity.newSessionDraftVisible', false);

/** The ChatGPT page is showing its new conversation composer. */
export const ChatGPTNewDraftContext = new RawContextKey<boolean>('sessions.activity.chatgptNewDraft', false);
