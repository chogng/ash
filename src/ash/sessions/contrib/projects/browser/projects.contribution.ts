import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { CHAT_WORKSPACE_NAVIGATION_ID } from '../../chat/common/constants.js';
import { groupChatList, IChatListCatalog } from '../../chat/browser/chatListModel.js';
import { ProjectsEditorPane } from './projectsEditor.js';
import { ProjectTitleBarContribution } from './projectTitleBarWidget.js';
import { IProjectsService, ProjectsService } from './projectsService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import './projectsRepairActions.js';

registerSingleton(IProjectsService, ProjectsService, InstantiationType.Delayed);
registerWorkbenchContribution(ProjectTitleBarContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(ProjectTitleBarContribution));

CommandsRegistry.register('sessions.show.projects', (accessor, source) =>
	accessor
		.get(ISessionsLayoutService)
		.openEntry(
			{
				id: 'projects',
				workspaceMode: 'chat',
				activityContext: 'sessions.activity.projectsSelected',
				content: 'editor',
				sidebarContainerId: SessionsViewRegistry.getViewContainer(CHAT_WORKSPACE_NAVIGATION_ID)?.id,
				showEditorTabs: false,
				restoreCommand: 'sessions.show.projects',
				focus: 'editor',
				editorInput: {
					resource: URI.from({ scheme: 'ash-projects', path: '/page' }),
					label: localize('projects.title', 'Projects'),
					showBreadcrumbs: false,
					readOnly: true,
					capabilities: EditorInputCapabilities.CannotClose,
				},
			},
			undefined,
			source === 'restore' ? { source } : undefined,
		),
);

registerEditorPane({
	id: 'sessions.editor.projects',
	name: localize('projects.title', 'Projects'),
	canOpen: input => (input.resource.scheme === 'ash-projects' ? EditorPaneMatch.Default : EditorPaneMatch.None),
	create: options => options.instantiationService!.createInstance(ProjectsEditorPane),
});

CommandsRegistry.register('sessions.createProject', async accessor => {
	const commands = accessor.get(ICommandService);
	const editor = accessor.get(IEditorPart);
	const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument);
	if (!(editor.activePane instanceof ProjectsEditorPane) || !editor.activePane.isVisible()) {
		await commands.executeCommand('sessions.show.projects');
	}
	if (editor.activePane instanceof ProjectsEditorPane && editor.activePane.isVisible()) {
		// Let the dialog return focus to the sidebar trigger after opening the page.
		if (isHTMLElement(focused) && focused.isConnected) focused.focus();
		editor.activePane.createProject();
	}
});

registerAction2(
	class OpenProjects extends Action2 {
		constructor() {
			super({
				id: 'sessions.open.projects',
				title: localize2({ bundle: 'ash', key: 'sessions.activity.projects' }, 'Projects'),
				icon: Lxicon.projects,
				toggled: ContextKeyExpr.has('sessions.activity.projectsSelected'),
				menu: { id: Menus.ActivityBar, group: 'navigation', order: 30, when: ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code') },
			});
		}
		public override async run(accessor: ServicesAccessor, projectId?: unknown): Promise<void> {
			if (projectId !== undefined) {
				if (typeof projectId !== 'string' || !projectId.trim())
					throw new TypeError(localize('projects.invalidId', 'Choose a valid project.'));
				const projects = accessor.get(IProjectsService);
				const groups = groupChatList(accessor.get(IChatListCatalog).sources.map(source => source.snapshot.get()), 'projects');
				if (!projects.state.get().projects.some(project => project.id === projectId) && groups.some(group => group.key === projectId)) {
					projects.openConversationProject(projectId);
				} else {
					await projects.openProject(projectId);
				}
			}
			await accessor.get(ICommandService).executeCommand('sessions.show.projects');
		}
	},
);

registerAction2(class ToggleArchivedProjects extends Action2 {
	constructor() {
		super({
			id: 'sessions.toggleArchivedProjects',
			title: localize2('projects.toggleArchived', 'Toggle Archived Projects'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(IEditorPart);
		if (!(editor.activePane instanceof ProjectsEditorPane) || !editor.activePane.isVisible()) {
			await accessor.get(ICommandService).executeCommand('sessions.show.projects');
		}
		if (editor.activePane instanceof ProjectsEditorPane && editor.activePane.isVisible()) {
			editor.activePane.toggleArchivedProjects();
		}
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Projects,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(
				localize('projects.verbosityInvalid', 'Projects accessibility verbosity must be boolean'),
			);
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('projects.verbosityTitle', 'Projects accessibility help'),
		description: localize(
			'projects.verbosityDescription',
			'Announce how to open accessibility help when Projects receives focus.',
		),
	},
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
				() =>
					type === AccessibleViewType.Help
						? localize(
							'projects.help',
							'Projects organizes your work into named spaces. The title bar sidebar toggle hides or shows global navigation without leaving Projects. Use Tab to enter the project actions toolbar. Use Left and Right Arrow to move between Search, Sort and New project, and Home and End to reach the first and last action. Search expands an input in the toolbar. An empty search collapses when focus leaves it; a search with text stays visible. Use Tab to reach Close project search, or Escape to clear the search and return to its button. Left and Right Arrow, Home and End edit text while the search input is focused. Use Tab again to leave the toolbar. On Sort, Up or Down Arrow opens the menu. Sort opens a menu with Last updated, Date created and Alphabetical. Use arrow keys to choose an order, Enter to apply it and Escape to close the menu. Pinned projects stay first in every order. Your chosen sort order is remembered for this profile. Use arrow keys, Home and End within the project cards. Enter opens a project. In a project, Tab to Project conversations. Use Up or Down Arrow, Home and End to move between conversations and Enter to open one. Use the Projects breadcrumb to return to the list. Use the Pin button to add a project shortcut to Pinned in the Chat sidebar. The shortcut is saved for this profile. Hover or focus a card to show More Actions. Edit details opens the project form. Archive and Delete appear when supported. Archive asks for confirmation and archives the project and its active conversations. Run Toggle Archived Projects from the Command Palette to switch between active and archived projects. Activate Unarchive for a project to return it to the active list. Its conversations keep their archived status. The Delete confirmation explains what will be removed. Create a project asks for a name and goals, with an optional folder. In a project, type in the chat input and send to start a conversation in that project. The input supports attachments, model selection and the usual chat keyboard shortcuts. Project changes keep your unsent draft. If project association or sending fails, the draft stays available for retry. Edit details changes the project name and goals. If another window changes the project, Reload and merge preserves your draft and includes saved materials. Choose which value to keep when both versions change the same field, then save. Add files accepts images, PDFs, documents and other file types. Use a folder adds a folder reference. Files stay in their original location; Remove only removes the project reference. Open a file to use its editor, or open a folder to choose a file inside it. Escape requests to close the project form. If you changed the form, choose Keep editing to return to it, or Discard to close it and return focus. Projects in the title bar breadcrumb returns to the project list. Activate the project name in the breadcrumb to rename it in place. The name is selected for editing. Enter or leaving the field saves, Escape cancels, and an empty name keeps the original. A failed save keeps your draft for retry. <keybinding:editor.action.accessibleView> reads the current project and material names.',
						) + ' ' + localize('projects.repairHelp', 'Use the Command Palette to run Archive Conversations in Archived Projects or Link Unassigned Code Conversations to Folder Projects. Use Space to select conversations and Enter to apply the selected changes.')
						: [
							projects.getAccessibleContent(),
							...Array.from(focused?.closest('.ash-projects')?.querySelectorAll<HTMLElement>(
								'.ash-projects-conversations, [data-conversation-project]',
							) ?? [], item => item.innerText),
						].filter(Boolean).join('\n'),
				() => {
					const searchField = focused.closest<HTMLElement>('.ash-toolbar-search-field');
					if (searchField?.inert) {
						searchField.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
					} else {
						focused.focus();
					}
				},
				AccessibilityVerbositySettingId.Projects,
			);
		},
	});
}
