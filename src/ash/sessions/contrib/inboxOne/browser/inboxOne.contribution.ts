import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IInboxNotificationsService } from '../../../../workbench/contrib/sessions/common/inboxNotificationsService.js';
import { SHOW_INBOX_NOTIFICATIONS_COMMAND_ID } from '../../../../workbench/contrib/sessions/browser/inboxNotificationsConstants.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsActivityBarLocationContext, SessionsActivityBarOnSide } from '../../../common/contextkeys.js';
import { InboxNotificationsService } from './inboxNotificationsService.js';
import { ISessionInbox, SessionInbox } from './sessionInbox.js';

registerSingleton(IInboxNotificationsService, InboxNotificationsService, InstantiationType.Delayed);
registerSingleton(ISessionInbox, SessionInbox, InstantiationType.Delayed);

const inboxInSidebar = ContextKeyExpr.and(
	ContextKeyExpr.notEquals(SessionsActivityBarLocationContext.key, 'left'),
	ContextKeyExpr.notEquals(SessionsActivityBarLocationContext.key, 'right'),
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_INBOX_NOTIFICATIONS_COMMAND_ID,
			title: localize2({ bundle: 'ash.sessions', key: 'sessions.inbox.show' }, 'Show Inbox'),
			shortTitle: localize2({ bundle: 'ash.sessions', key: 'sessions.inbox.title' }, 'Inbox'),
			f1: true,
			menu: [
				{ id: Menus.SidebarFooter, group: 'navigation', order: 0, when: SessionsActivityBarOnSide },
				{ id: Menus.SidebarFooter, group: 'navigation', order: 20, when: inboxInSidebar },
			],
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ISessionInbox).showInbox();
	}
});

registerWorkbenchContribution('sessions.contrib.inboxOne', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IActionViewItemService).register(Menus.SidebarFooter, SHOW_INBOX_NOTIFICATIONS_COMMAND_ID,
		(action, options, instantiation) => instantiation.get(ISessionInbox).createActionViewItem(action, options)));

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 110,
	name: 'sessionsInboxHelp',
	when: ContextKeyExpr.has('sessionsInboxFocused'),
	getProvider: (_accessor, target) => {
		const focused = target ?? getActiveElement();
		if (!isHTMLElement(focused)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsActivityBar,
			{ type: AccessibleViewType.Help },
			() => localize({ bundle: 'ash.sessions', key: 'sessions.inbox.help' }, 'Inbox is at the bottom of the sidebar. In the Left and Right positions, it is just above Accounts in the Activity Bar. Use Tab to focus Inbox and press Enter to show unread replies, failed runs, conversations needing your input and pull request notifications in the current mode. Show Inbox is also available in the Command Palette. Use Tab to move through the entries, Enter to open a conversation, or Escape to return to the Inbox button. Press Shift+F10 on Inbox to sort or view dismissed, held and done items. Press Shift+F10 on an entry to open or dismiss the notification, or to put its session on hold, resume it or mark it done.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.SessionsActivityBar,
		);
	},
});
