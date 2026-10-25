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
import { ProjectsEditorPane } from './projectsEditor.js';
import { IProjectsService, ProjectsService } from './projectsService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

registerSingleton(IProjectsService, ProjectsService, InstantiationType.Delayed);

CommandsRegistry.register('sessions.show.projects', (accessor, source) => accessor.get(ISessionsLayoutService).openEntry({
	id: 'projects', activityContext: 'sessions.activity.projectsSelected', content: 'editor',
	showEditorTabs: false,
	restoreCommand: 'sessions.show.projects', focus: 'editor',
	editorInput: {
		resource: URI.from({ scheme: 'ash-projects', path: '/page' }), label: localize('projects.title', 'Projects'),
		showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
	},
}, undefined, source === 'restore' ? { source } : undefined));

registerEditorPane({ id: 'sessions.editor.projects', name: localize('projects.title', 'Projects'), canOpen: input => input.resource.scheme === 'ash-projects' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(ProjectsEditorPane) });

registerAction2(class OpenProjects extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.projects', title: localize2({ bundle: 'ash', key: 'sessions.activity.projects' }, 'Projects'), icon: Lxicon.projects,
			toggled: ContextKeyExpr.has('sessions.activity.projectsSelected'),
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 30 },
		});
	}
	public override async run(accessor: ServicesAccessor, projectId?: unknown): Promise<void> {
		if (projectId !== undefined) {
			if (typeof projectId !== 'string' || !projectId.trim()) throw new TypeError(localize('projects.invalidId', 'Choose a valid project.'));
			await accessor.get(IProjectsService).openProject(projectId);
		}
		await accessor.get(ICommandService).executeCommand('sessions.show.projects');
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Projects,
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
		name: `sessionsProjects${type}`,
		when: ContextKeyExpr.has('sessionsProjectsFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const projects = accessor.get(IProjectsService);
			return new AccessibleContentProvider(
				AccessibleViewProviderId.Projects,
				{ type },
				() => type === AccessibleViewType.Help ? localize('projects.help', 'Projects organizes your work into named spaces. The title bar sidebar toggle hides or shows global navigation without leaving Projects. Use Tab to enter the project actions toolbar. Use Left and Right Arrow to move between Search, Sort and New project, and Home and End to reach the first and last action. Search expands an input in the toolbar. An empty search collapses when focus leaves it; a search with text stays visible. Use Tab to reach Close project search, or Escape to clear the search and return to its button. Left and Right Arrow, Home and End edit text while the search input is focused. Use Tab again to leave the toolbar. On Sort, Up or Down Arrow opens the menu. Sort opens a menu with Last updated, Date created and Alphabetical. Use arrow keys to choose an order, Enter to apply it and Escape to close the menu. Pinned projects stay first in every order. Your chosen sort order is remembered for this profile. Use arrow keys, Home and End within the project cards. Enter opens a project. Each card has a Pin button remembered for this profile. Hover or focus a card to show More Actions with Edit details, Archive and Delete. Archive hides the project from the active list. Delete removes project references while keeping conversations and source files. Create a project asks for a name and goals, with an optional folder. In a project, Edit details changes its name and goals. If another window changes the project, Reload and merge preserves your draft and includes saved materials. Choose which value to keep when both versions change the same field, then save. Add files accepts images, PDFs, documents and other file types. Use a folder adds a folder reference. Files stay in their original location; Remove only removes the project reference. Open a file to use its editor, or open a folder to choose a file inside it. Escape closes the creation dialog and returns focus. Projects in the title bar breadcrumb returns to the project list. <keybinding:editor.action.accessibleView> reads the current project and material names.') : projects.getAccessibleContent(),
				() => {
					const searchField = focused.closest<HTMLElement>('.ash-projects-search-field');
					if (searchField?.inert) {
						searchField.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
					} else { focused.focus(); }
				},
				AccessibilityVerbositySettingId.Projects,
			);
		},
	});
}
