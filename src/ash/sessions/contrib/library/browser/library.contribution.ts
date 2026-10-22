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
import { ILibraryService, LibraryService } from './libraryService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

registerSingleton(ILibraryService, LibraryService, InstantiationType.Delayed);

CommandsRegistry.register('sessions.show.library', (accessor, source) => accessor.get(ISessionsLayoutService).openEntry({
	id: 'library', activityContext: 'sessions.activity.librarySelected', content: 'editor',
	showEditorTabs: false,
	restoreCommand: 'sessions.show.library', focus: 'editor',
	editorInput: {
		resource: URI.from({ scheme: 'ash-library', path: '/page' }), label: localize('projects.title', 'Projects'),
		showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
	},
}, undefined, source === 'restore' ? { source } : undefined));

registerEditorPane({ id: 'sessions.editor.library', name: localize('projects.title', 'Projects'), canOpen: input => input.resource.scheme === 'ash-library' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(LibraryEditorPane) });

registerAction2(class OpenLibrary extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.library', title: localize2({ bundle: 'ash', key: 'sessions.activity.library' }, 'Projects'), icon: Lxicon.projects,
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
		if (typeof value !== 'boolean') { throw new TypeError(localize('projects.verbosityInvalid', 'Projects accessibility verbosity must be boolean')); }
		return value;
	},
	setting: { valueType: 'boolean', title: localize('projects.verbosityTitle', 'Projects accessibility help'), description: localize('projects.verbosityDescription', 'Announce how to open accessibility help when Projects receives focus.') },
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
				() => type === AccessibleViewType.Help ? localize('projects.help', 'Projects organizes your work into named spaces. Use Tab to reach Search, Sort and New project. Use arrow keys, Home and End within the project cards. Enter opens a project. Create a project asks for a name and goals, with an optional folder. In a project, Edit details changes its name and goals. Add files accepts images, PDFs, documents and other file types. Use a folder adds a folder reference. Files stay in their original location; Remove only removes the project reference. Open a file to use its editor, or open a folder to choose a file inside it. Escape closes the creation dialog and returns focus. Projects in the breadcrumb returns to the project list. <keybinding:editor.action.accessibleView> reads the current project and material names.') : library.getAccessibleContent(),
				() => focused.focus(),
				AccessibilityVerbositySettingId.Library,
			);
		},
	});
}
