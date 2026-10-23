import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

// Navigation history belongs to the Sessions service; these keys only expose it to action conditions.
export const CanGoBackContext = new RawContextKey<boolean>('sessionsCanGoBack', false);
export const CanGoForwardContext = new RawContextKey<boolean>('sessionsCanGoForward', false);
/** Narrow titlebar navigation moves history into the Go menu. */
export const CompactTitlebarNavigationContext = new RawContextKey<boolean>('sessions.compactTitlebarNavigation', false);
/** The product workspace owning the current page and its sidebar navigation. */
export const SessionsWorkspaceModeContext = new RawContextKey<'chat' | 'code'>('sessions.workspaceMode', 'chat');

/** The navigation action whose context menu is being resolved. */
export const ActivityBarItemContext = new RawContextKey<string>('sessions.activityBar.actionId', '');
