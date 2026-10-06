import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../services/layout/common/sessionsLayoutService.js';
import { CreatorMode } from '../common/creator.js';
import { DESIGN_LAYERS_CONTAINER_ID, DESIGN_PROPERTIES_CONTAINER_ID } from './designEditorService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Menus } from '../../../browser/menus.js';
import { CreatorPage, CreatorEditorPane, CreatorNavigationView } from './creatorPage.js';
import { CREATOR_NAVIGATION_CONTAINER_ID } from './creatorWorkspace.js';
import { CreatorWorkspaceView } from './creatorViews.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';

registerEditorPane({ id: 'sessions.editor.creator', name: 'Creator', canOpen: input => input.resource.scheme === 'ash-creator' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(CreatorEditorPane) });

function openCreator(accessor: ServicesAccessor, workspace?: CreatorMode | 'home'): Promise<void> {
	const editor = accessor.get(IEditorPart);
	const entry: ISessionsEntry = {
		id: 'creator.home', activityContext: 'sessions.activity.creatorSelected', content: 'editor',
		sidebarContainerId: CREATOR_NAVIGATION_CONTAINER_ID, restoreCommand: 'sessions.restore.creator', focus: 'editor',
		editorInput: {
			resource: URI.from({ scheme: 'ash-creator', path: '/page' }), label: localize('sessions.creator.title', 'Creator'),
			showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
		},
	};
	return accessor.get(ISessionsLayoutService).openEntry(entry, () => {
		const page = (editor.activePane as CreatorEditorPane).page;
		if (workspace === 'home') { page.showHome(); }
		else if (workspace) { page.openMode(workspace); }
		return page.usesCanvasPanels ? {
			...entry, id: 'creator.canvas', sidebarContainerId: DESIGN_LAYERS_CONTAINER_ID,
			detailsContainerId: DESIGN_PROPERTIES_CONTAINER_ID,
		} : entry;
	});
}

CommandsRegistry.register('sessions.show.creator', accessor => openCreator(accessor, 'home'));
CommandsRegistry.register('sessions.restore.creator', accessor => openCreator(accessor));
CommandsRegistry.register('sessions.restore.creatorDesign', accessor => openCreator(accessor, CreatorMode.Design));
CommandsRegistry.register('sessions.creator.openMode', (accessor, value) => {
	if (!Object.values(CreatorMode).includes(value as CreatorMode)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Creator document mode.')); }
	return openCreator(accessor, value as CreatorMode);
});
SessionsViewRegistry.registerStaticViewContainer({ id: CREATOR_NAVIGATION_CONTAINER_ID, title: 'Creator', localizationKey: { bundle: 'ash', key: 'sessions.creator.title' }, location: ViewContainerLocation.Sidebar, order: 4 });
SessionsViewRegistry.registerStaticViews(CREATOR_NAVIGATION_CONTAINER_ID, [{ id: CREATOR_NAVIGATION_CONTAINER_ID + '.view', title: 'Creator', localizationKey: { bundle: 'ash', key: 'sessions.creator.title' }, ctorDescriptor: new SyncDescriptor(CreatorNavigationView), canToggleVisibility: false }]);

registerAction2(class OpenCreator extends Action2 {
	constructor() {
		super({ id: 'sessions.open.creator', title: localize2('sessions.creator.title', 'Creator'), icon: Lxicon.symbolColor, toggled: { condition: ContextKeyExpr.has('sessions.activity.creatorSelected'), icon: Lxicon.symbolColorFilled }, menu: { id: Menus.ActivityBar, group: 'navigation', order: 50 } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand('sessions.show.creator'); }
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Creator,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('sessions.creator.verbosityInvalid', 'Creator accessibility verbosity must be boolean.')); }
		return value;
	},
	setting: { valueType: 'boolean', get title() { return localize('sessions.creator.verbosityTitle', 'Creator accessibility help'); }, get description() { return localize('sessions.creator.verbosityDescription', 'Announce how to open accessibility help in Creator.'); } },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 90,
		name: `sessionsCreator${type}`,
		when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsCreatorFocused'), ContextKeyExpr.has('sessionsCreatorNavigationFocused')),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const page = CreatorPage.getFocused(focused) ?? CreatorNavigationView.getFocused(focused) ?? CreatorWorkspaceView.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type }, () => type === AccessibleViewType.Help ? `${localize('sessions.creator.help', 'Creator\nUse Tab and Shift+Tab to choose a workspace, then press Enter. Creator home returns to the mode list and keeps each workspace document, selection and viewport. Save document and Open document are available from Workspace actions. Pages selects a slide, website page or prototype screen. Preview controls support Left and Right on the preview and Escape to return.')}\n\n${page.getAccessibleContent()}` : page.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
