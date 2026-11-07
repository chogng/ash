import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

// Navigation history belongs to the Sessions service; these keys only expose it to action conditions.
export const CanGoBackContext = new RawContextKey<boolean>('sessionsCanGoBack', false);
export const CanGoForwardContext = new RawContextKey<boolean>('sessionsCanGoForward', false);
/** The product workspace owning the current page and its sidebar navigation. */
export const SessionsWorkspaceModeContext = new RawContextKey<'chat' | 'code'>('sessions.workspaceMode', 'chat');

/** The Code conversation page is active. Other pages can share its workspace mode. */
export const CodeConversationPageContext = new RawContextKey<boolean>('sessions.activity.codeSelected', false);

/** The navigation action whose context menu is being resolved. */
export const ActivityBarItemContext = new RawContextKey<string>('sessions.activityBar.actionId', '');

/** Describes the row that opened a Sessions context menu. */
export const SessionsMenuActiveConversationContext = new RawContextKey<boolean>('sessions.menu.activeConversation', false);
export const SessionsMenuConversationPinnedContext = new RawContextKey<boolean>('sessions.menu.conversationPinned', false);
export const SessionsMenuCanChangeFolderContext = new RawContextKey<boolean>('sessions.menu.canChangeFolder', false);
export const SessionsMenuCanClearFolderContext = new RawContextKey<boolean>('sessions.menu.canClearFolder', false);
export const SessionsMenuWorkspaceIdleContext = new RawContextKey<boolean>('sessions.menu.workspaceIdle', false);
export const SessionsMenuCanMoveConversationContext = new RawContextKey<boolean>('sessions.menu.canMoveConversation', false);

/** The current entry is showing its new conversation draft. */
export const NewSessionDraftVisibleContext = new RawContextKey<boolean>('sessions.activity.newSessionDraftVisible', false);

/** The conversation area is showing a new session, including while its draft is being edited. */
export const IsNewSessionContext = new RawContextKey<boolean>('sessions.isNewSession', false);

/** The active draft has selected a workspace and the window has a folder it can use. */
export const NewSessionHasUsableWorkspaceContext = new RawContextKey<boolean>('sessions.newSessionHasUsableWorkspace', false);
