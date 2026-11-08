import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { BotsEditor, BotsNavigationView, botsFocusContext, botsNavigationId, botsResource } from './botsViews.js';

const title = localize2('sessions.bots.title', 'Bots');
const selectedContext = 'sessions.activity.botsSelected';

SessionsViewRegistry.registerViewContainer({
	id: botsNavigationId, title: title.value, location: ViewContainerLocation.Sidebar, order: 6,
});
SessionsViewRegistry.registerViews(botsNavigationId, [{
	id: botsNavigationId + '.view', title: title.value, ctorDescriptor: new SyncDescriptor(BotsNavigationView), canToggleVisibility: false,
}]);
registerEditorPane({
	id: BotsEditor.ID, name: title.value,
	canOpen: input => input.resource.scheme === botsResource.scheme ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(BotsEditor),
});

registerAction2(class OpenBots extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.bots', title, icon: Lxicon.bot, f1: true,
			toggled: ContextKeyExpr.has(selectedContext),
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 25, when: SessionsWorkspaceModeContext.isEqualTo('code') },
		});
	}
	public override run(accessor: ServicesAccessor, source?: unknown): Promise<void> {
		return accessor.get(ISessionsLayoutService).openEntry({
			id: 'bots', workspaceMode: 'code', activityContext: selectedContext,
			content: 'editor', sidebarContainerId: botsNavigationId, showWorkspaceModeControl: false, showEditorTabs: false,
			restoreCommand: 'sessions.open.bots', focus: 'sidebar',
			editorInput: { resource: botsResource, label: title.value, readOnly: true, showBreadcrumbs: false },
		}, undefined, source === 'restore' ? { source } : undefined);
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Bots,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError(localize('sessions.bots.verbosityInvalid', 'Bots accessibility verbosity must be boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('sessions.bots.verbosityTitle', 'Bots Accessibility Help'),
		description: localize('sessions.bots.verbosityDescription', 'Announce how to open accessibility help when the Bots page receives focus.'),
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 130, name: `sessionsBots.${type}`, when: ContextKeyExpr.has(botsFocusContext),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument);
			const pane = accessor.get(IEditorPart).activePane;
			const sidebar = focused?.closest<HTMLElement>('.ash-bots-sidebar');
			return new AccessibleContentProvider(AccessibleViewProviderId.Bots, { type }, () => {
				if (type === AccessibleViewType.Help) {
					return localize('sessions.bots.help', 'Bots groups conversations by assistant. Use Back to return to Code and Search to filter bots and threads. Press Enter or Space on Code Review to expand it, and use Up or Down Arrow to move between bot and thread rows. Activate a thread to show its conversation. Choose Review Changes to review the active Code conversation. Save comments on lines and choose Send to Code Review to create a new thread. Activate a file reference in a message to read the saved comparison. Press Escape or choose Close Comparison to return to the conversation. <keybinding:editor.action.accessibleView> reads the current region.');
				}
				return sidebar?.innerText ?? (pane instanceof BotsEditor ? pane.getAccessibleContent(focused) : '');
			}, () => {
				if (isHTMLElement(focused) && focused.isConnected) focused.focus();
				else if (pane instanceof BotsEditor) pane.focus();
			}, AccessibilityVerbositySettingId.Bots);
		},
	});
}
