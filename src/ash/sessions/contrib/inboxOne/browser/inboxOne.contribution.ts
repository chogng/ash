import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionInbox } from './sessionInbox.js';

registerWorkbenchContribution('sessions.contrib.inboxOne', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(SessionInbox));

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
			() => localize({ bundle: 'ash.sessions', key: 'sessions.inbox.help' }, 'Use Tab to focus Inbox at the bottom of the sidebar and press Enter to show unread replies, failed runs and conversations needing your input in the current mode. Use Tab to move through the entries, Enter to open a conversation, or Escape to return to the Inbox button.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.SessionsActivityBar,
		);
	},
});
