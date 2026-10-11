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
				() => localize('chat.sessions.help', 'Agent Sessions\nUse Tab and Shift+Tab to reach the New Session button, search field, and session rows. Type in Search sessions to filter the list; press Arrow Down to reach the first row. Use Arrow Up and Arrow Down to move between rows, and Enter or Space to open one. Selecting a session returns to Chat unless the list is shown side by side. Press Escape to close the list and return to its toggle. In Chat More Actions, Sessions layout offers Automatic, Side by side, and Stacked. In side by side layout, drag the separator to resize the list, or focus it with Tab and use Arrow Left and Arrow Right; hold Alt for finer adjustments. Double-click the separator to restore its default width. Narrow panels can show the list in place of Chat. Stacked is only used above a new chat input.'),
				() => focusTarget.focus(),
				AccessibilityVerbositySettingId.AgentSessions,
			);
		},
	}));
	return disposables;
}
