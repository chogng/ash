import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';

// Navigation history belongs to the Sessions service; these keys only expose it to action conditions.
export const CanGoBackContext = new RawContextKey<boolean>('sessionsCanGoBack', false);
export const CanGoForwardContext = new RawContextKey<boolean>('sessionsCanGoForward', false);

/** The navigation action whose context menu is being resolved. */
export const ActivityBarItemContext = new RawContextKey<string>('sessions.activityBar.actionId', '');
