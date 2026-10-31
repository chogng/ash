import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.AgentSessions,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Agent Sessions accessibility verbosity must be boolean');
		return value;
	},
});

export function registerAgentSessionsAccessibility(sidebar: HTMLElement, contextKeyService: IContextKeyService): IDisposable {
	const disposables = new DisposableStore();
	const scopedContext = disposables.add(contextKeyService.createScoped(sidebar));
	scopedContext.createKey('agentSessionsSidebarFocused', true);
	disposables.add(AccessibleViewRegistry.register({
		type: AccessibleViewType.Help,
		priority: 100,
		name: 'agentSessionsHelp',
		when: ContextKeyExpr.has('agentSessionsSidebarFocused'),
		getProvider: () => {
			const active = sidebar.ownerDocument.activeElement;
			const focusTarget = isHTMLElement(active) && sidebar.contains(active) ? active : sidebar;
			return new AccessibleContentProvider(
				AccessibleViewProviderId.AgentSessions,
				{ type: AccessibleViewType.Help },
				() => localize('chat.sessions.help', 'Agent Sessions\nUse Tab and Shift+Tab to reach New Session, search and the sessions tree. Type in Search sessions to filter the list. In the tree, Up and Down move focus, Left and Right collapse or expand a section, and Home and End move to the first or last row. Enter opens a session and focuses Chat. Space opens a session while keeping focus in a side-by-side list. Tab from a focused session reaches More actions; Shift+F10 opens its menu. A stacked list closes when a session opens; a side-by-side list stays open. Escape closes the list and returns to Chat. The input stays visible for both new chats and existing conversations. Hover or focus a session to reveal More actions, or press Shift+F10 to open its menu. Organizing keeps the unsent draft. In Chat More Actions, Session display switches between Tabs and List. Tabs show opened sessions; the list and history remain available for all sessions. In either display mode, the Sessions button docks the list beside Chat, including an already visible stacked list. It widens the hosting side bar when needed. Using the Sessions button to close it restores the previous width. On the tab row, Left and Right move focus, Enter or Space activates a tab, and Delete closes it. Closing a tab keeps the session, draft and running work. In List mode, Chat automatically opens the sessions sidebar when there is room for both columns. Narrower Chat areas show the list above the input. Drag the separator past its minimum-width threshold to keep sessions stacked above Chat, even after widening the window. In the Command Palette, Show Agent Sessions Sidebar restores side-by-side layout; Stack Agent Sessions Above Chat switches to stacked layout. Resizing preserves focus and drafts, and a manually closed list stays closed. Switching display modes preserves your conversations and drafts.'),
				() => focusTarget.focus(),
				AccessibilityVerbositySettingId.AgentSessions,
			);
		},
	}));
	return disposables;
}
