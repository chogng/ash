import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ISymphonyService, SymphonyService, SymphonyNavigationId, SymphonyMonitorResource } from './symphonyService.js';
import { SymphonyTasksView, SymphonyMonitorEditor, symphonyAccessibleContent } from './symphonyViews.js';

registerSingleton(ISymphonyService, SymphonyService, InstantiationType.Delayed);

const configuration = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
configuration.registerConfiguration({
	key: AccessibilityVerbositySettingId.Symphony, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Symphony accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('symphony.verbosityTitle', 'Symphony accessibility help'), description: localize('symphony.verbosityDescription', 'Announce keyboard help when Symphony controls receive focus.') },
});

SessionsViewRegistry.registerViewContainer({ id: SymphonyNavigationId, title: 'Symphony', location: ViewContainerLocation.Sidebar, order: 7 });
SessionsViewRegistry.registerViews(SymphonyNavigationId, [{ id: SymphonyNavigationId + '.view', title: 'Symphony', ctorDescriptor: new SyncDescriptor(SymphonyTasksView), canToggleVisibility: false }]);
registerEditorPane({ id: 'sessions.editor.symphony', name: 'Symphony', canOpen: input => input.resource.scheme === 'ash-symphony' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(SymphonyMonitorEditor) });

async function openSymphony(accessor: ServicesAccessor): Promise<void> {
	const symphony = accessor.get(ISymphonyService);
	await symphony.refresh();
	await accessor.get(ISessionsLayoutService).openEntry({
		id: 'symphony', activityContext: 'sessions.activity.symphonySelected', content: 'editor',
		sidebarContainerId: SymphonyNavigationId, restoreCommand: 'sessions.open.symphony', focus: 'editor',
		editorInput: { resource: SymphonyMonitorResource, label: 'Symphony', readOnly: true, showBreadcrumbs: false },
	});
}

registerAction2(class OpenSymphony extends Action2 {
	constructor() {
		super({ id: 'sessions.open.symphony', title: localize2('symphony.title', 'Symphony'), f1: true, icon: Lxicon.agent,
			toggled: ContextKeyExpr.has('sessions.activity.symphonySelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 70 } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await openSymphony(accessor); }
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({ type, priority: 100, name: `sessionsSymphony${type}`, when: ContextKeyExpr.has('sessionsSymphonyFocused'), getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		return new AccessibleContentProvider(AccessibleViewProviderId.Symphony, { type },
			() => type === AccessibleViewType.Help ? localize('symphony.help', 'Symphony schedules tasks inside Ash. Load an absolute WORKFLOW.md path, select a workflow and create a task. GitHub and Linear workflows also poll issues automatically. Tab moves between controls; Up, Down, Home and End select conversations in the list. The monitor shows messages, status, cumulative tokens and runtime. Pause stops the current Turn; Resume keeps the same conversation. Pause dispatch only prevents new work. Complete stops a task. Closing this page leaves scheduling running. Totals include all runs and retries; runtime excludes paused time. <keybinding:editor.action.accessibleView> reads the monitor as text.') : symphonyAccessibleContent(accessor.get(ISymphonyService)),
			() => focused?.focus(), AccessibilityVerbositySettingId.Symphony);
	} });
}
