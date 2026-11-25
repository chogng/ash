import { ContextKeyExpr, RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import type { ArtifactKind } from './artifactKind.js';
import type { SessionsActivityBarLocation } from './configuration.js';

/** The artifact owning a toolbar or context menu, scoped to its editor rather than global focus. */
export const ArtifactKindContext = new RawContextKey<ArtifactKind | undefined>('sessions.artifacts.kind', undefined);

// Navigation history belongs to the Sessions service; these keys only expose it to action conditions.
export const CanGoBackContext = new RawContextKey<boolean>('sessionsCanGoBack', false);
export const CanGoForwardContext = new RawContextKey<boolean>('sessionsCanGoForward', false);
/** The product workspace owning the current page and its sidebar navigation. */
export const SessionsWorkspaceModeContext = new RawContextKey<'chat' | 'code'>('sessions.workspaceMode', 'chat');

/** Whether the visible entry allows the title bar workspace mode control. */
export const SessionsEntryShowsWorkspaceModeControlContext = new RawContextKey<boolean>('sessions.entryShowsWorkspaceModeControl', true);

export const SessionsEntryDetailsContext = new RawContextKey<string | undefined>('sessions.entryDetails', undefined);

/** The Code conversation page is active. Other pages can share its workspace mode. */
export const CodeConversationPageContext = new RawContextKey<boolean>('sessions.activity.codeSelected', false);
export const ChatConversationPageContext = new RawContextKey<boolean>('sessions.chatConversationPage', false);

/** The navigation action whose context menu is being resolved. */
export const ActivityBarItemContext = new RawContextKey<string>('sessions.activityBar.actionId', '');

/** Layout projection for the actions shared by the sidebar footer and title bar. */
export const SessionsActivityBarLocationContext = new RawContextKey<SessionsActivityBarLocation | undefined>('sessions.activityBar.location', undefined);
export const SessionsActivityBarOnSide = ContextKeyExpr.or(SessionsActivityBarLocationContext.isEqualTo('left'), SessionsActivityBarLocationContext.isEqualTo('right'))!;

/** Describes the row that opened a Sessions context menu. */
export const SessionsMenuActiveConversationContext = new RawContextKey<boolean>('sessions.menu.activeConversation', false);
export const SessionsMenuConversationPinnedContext = new RawContextKey<boolean>('sessions.menu.conversationPinned', false);
export const SessionsMenuCanSetFolderContext = new RawContextKey<boolean>('sessions.menu.canSetFolder', false);
export const SessionsMenuWorkspaceIdleContext = new RawContextKey<boolean>('sessions.menu.workspaceIdle', false);
export const SessionsMenuCanMoveConversationContext = new RawContextKey<boolean>('sessions.menu.canMoveConversation', false);

/** The current entry is showing its new conversation draft. */
export const NewSessionDraftVisibleContext = new RawContextKey<boolean>('sessions.activity.newSessionDraftVisible', false);

/** The conversation area is showing a new session, including while its draft is being edited. */
export const IsNewSessionContext = new RawContextKey<boolean>('sessions.isNewSession', false);

/** The active draft has selected a workspace and the window has a folder it can use. */
export const NewSessionHasUsableWorkspaceContext = new RawContextKey<boolean>('sessions.newSessionHasUsableWorkspace', false);
