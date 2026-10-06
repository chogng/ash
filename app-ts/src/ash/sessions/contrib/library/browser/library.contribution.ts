import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Menus } from '../../../browser/menus.js';
import { LibraryEditorPane } from './libraryEditor.js';
import { ILibraryService, LibraryService, LIBRARY_NAVIGATION_CONTAINER_ID, LIBRARY_DETAILS_CONTAINER_ID } from './libraryService.js';
import { LibraryNavigationView, LibraryDetailsView } from './libraryViews.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

registerSingleton(ILibraryService, LibraryService, InstantiationType.Delayed);

CommandsRegistry.register('sessions.show.library', accessor => accessor.get(ISessionsLayoutService).openEntry({
	id: 'library', activityContext: 'sessions.activity.librarySelected', content: 'editor',
	sidebarContainerId: LIBRARY_NAVIGATION_CONTAINER_ID, detailsContainerId: LIBRARY_DETAILS_CONTAINER_ID,
	restoreCommand: 'sessions.show.library', focus: 'editor',
	editorInput: {
		resource: URI.from({ scheme: 'ash-library', path: '/page' }), label: localize('library.title', 'Library'),
		showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
	},
}));

registerEditorPane({ id: 'sessions.editor.library', name: 'Library', canOpen: input => input.resource.scheme === 'ash-library' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(LibraryEditorPane) });

// Containers are discoverable before an editor opens. Their Views own their DOM and borrow only browsing state.
for (const [id, title, key, location, ctorDescriptor] of [
	[LIBRARY_NAVIGATION_CONTAINER_ID, 'Library', 'library.title', ViewContainerLocation.Sidebar, new SyncDescriptor(LibraryNavigationView)],
	[LIBRARY_DETAILS_CONTAINER_ID, 'Asset details', 'library.details', ViewContainerLocation.AuxiliaryBar, new SyncDescriptor(LibraryDetailsView)],
] as const) {
	SessionsViewRegistry.registerViewContainer({ id, title, localizationKey: { bundle: 'ash', key }, location, order: 3 });
	SessionsViewRegistry.registerViews(id, [{ id: id + '.view', title, localizationKey: { bundle: 'ash', key }, ctorDescriptor, canToggleVisibility: false }]);
}

registerAction2(class OpenLibrary extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.library', title: localize2({ bundle: 'ash', key: 'sessions.activity.library' }, 'Library'), icon: Lxicon.projects,
			toggled: { condition: ContextKeyExpr.has('sessions.activity.librarySelected'), icon: Lxicon.projectsFilled },
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 30 },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('sessions.show.library');
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Library,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Library accessibility verbosity must be boolean'); }
		return value;
	},
	setting: { valueType: 'boolean', title: localize('library.verbosityTitle', 'Library accessibility help'), description: localize('library.verbosityDescription', 'Announce how to open accessibility help when Library receives focus.') },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `sessionsLibrary${type}`,
		when: ContextKeyExpr.has('sessionsLibraryFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const library = accessor.get(ILibraryService);
			return new AccessibleContentProvider(
				AccessibleViewProviderId.Library,
				{ type },
				() => type === AccessibleViewType.Help ? localize('library.help', 'Library stores reusable images independently of conversations. Use Tab to move between categories, search, Import, sorting, view controls and items. Use arrow keys within categories and the item grid; Home and End move to the first or last item. Enter or Space opens asset details. Details shows the source and exact version, lets you add or remove favorites, and choose collection membership. Add to conversation attaches the image to your current Chat draft without sending it. Use in Design places that exact image version on the canvas. Escape closes details and returns to the item. Import accepts PNG, JPEG and WebP images. New collection asks for a name. Search matches names and sources in the selected category. Grid and list views remember your choice. Refresh reads the latest catalog. <keybinding:editor.action.accessibleView> opens a text description of the current items.') : library.getAccessibleContent(),
				() => focused.focus(),
				AccessibilityVerbositySettingId.Library,
			);
		},
	});
}
