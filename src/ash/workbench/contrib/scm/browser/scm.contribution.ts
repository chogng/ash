import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { ScmAgentReviewViewPane } from "./scmAgentReviewViewPane.js";
import { SCMHistoryViewPane } from "./scmHistoryViewPane.js";
import { SCMActiveRepositoryController, ScmStatusContribution } from './activity.js';
import { ScmViewPane } from "./scmViewPane.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IEditorPart } from "../../../browser/parts/editor/editorPart.js";
import { ScmWorkingSetController } from "./workingSet.js";
import { ScmHistoryChatContextContribution } from "./scmHistoryChatContext.js";
import { SCMViewPaneContainer } from './scmViewPaneContainer.js';
import { IChatContextPickService } from "../../../services/chat/common/chatContextService.js";
import "./quickDiff.contribution.js";
import { localize, localize2 } from '../../../../nls.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import type { EditorPanePartOptions } from '../../../browser/parts/editor/textResourceEditor.js';
import { getBrowserTextResourceStore } from '../../codeEditor/browser/browserTextResourceStore.js';
import { createBrowserEditorPart } from '../../codeEditor/browser/browserEditorPart.js';
import { matchScmMergeEditor, SCM_MERGE_EDITOR_ID } from './scmMergeEditorInput.js';
import { ScmMergeEditorPane, ScmMergeFocusedContext } from './scmMergeEditorPane.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import './media/scmMergeEditor.css';
import './scm.service.contribution.js';
import { ISCMService, ISCMViewService, SCMHistoryBusyContext, SCMProviderContext, SCMViewModeContext, SCMViewSortKeyContext, VIEW_PANE_ID, type SCMViewMode, type SCMViewSortKey } from '../common/scm.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { isFocusable, restoreFocus } from '../../../../base/browser/focus.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { REPOSITORIES_VIEW_PANE_ID, SCMRepositoriesViewPane } from './scmRepositoriesViewPane.js';

const scmViewSortMenu = MenuId.for('SCMViewSort');
CommandsRegistry.register('workbench.scm.action.focusPreviousResourceGroup', async accessor => {
	const pane = await accessor.get(IViewsService).openView<ScmViewPane>(VIEW_PANE_ID);
	pane?.focusPreviousResourceGroup();
});
CommandsRegistry.register('workbench.scm.action.focusNextResourceGroup', async accessor => {
	const pane = await accessor.get(IViewsService).openView<ScmViewPane>(VIEW_PANE_ID);
	pane?.focusNextResourceGroup();
});
MenusRegistry.appendMenuItem(MenuId.SCMTitle, {
	submenu: scmViewSortMenu, title: localize2('scm.viewSort', 'View & Sort'),
	when: ContextKeyExpr.notEquals(SCMProviderContext.key, ''), group: '0_view', order: 2,
});

for (const mode of ['list', 'tree'] as const) {
	const title = mode === 'list' ? localize2('scm.viewAsList', 'View as List') : localize2('scm.viewAsTree', 'View as Tree');
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: mode === 'list' ? 'workbench.scm.action.setListViewMode' : 'workbench.scm.action.setTreeViewMode', title,
				toggled: SCMViewModeContext.isEqualTo(mode), menu: [
					{ id: scmViewSortMenu, group: '1_viewmode', order: mode === 'list' ? 1 : 2 },
					{ id: MenuId.SCMTitle, group: '0_view', order: 1, when: ContextKeyExpr.and(ContextKeyExpr.notEquals(SCMProviderContext.key, ''), ContextKeyExpr.notEquals(SCMViewModeContext.key, mode)) },
				]
			});
		}
		public override run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IViewsService).getViewWithId<ScmViewPane>(VIEW_PANE_ID);
			if (pane) pane.viewMode = mode satisfies SCMViewMode;
		}
	});
}

const sortActions = [
	{ key: 'path', title: localize2('scm.sortByPath', 'Sort Changes by Path') },
	{ key: 'name', title: localize2('scm.sortByName', 'Sort Changes by Name') },
	{ key: 'status', title: localize2('scm.sortByStatus', 'Sort Changes by Status') },
] as const;
for (const [order, action] of sortActions.entries()) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `workbench.scm.action.setSortKey.${action.key}`, title: action.title,
				precondition: SCMViewModeContext.isEqualTo('list'), toggled: SCMViewSortKeyContext.isEqualTo(action.key),
				menu: { id: scmViewSortMenu, group: '2_sort', order }
			});
		}
		public override run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IViewsService).getViewWithId<ScmViewPane>(VIEW_PANE_ID);
			if (pane) pane.viewSortKey = action.key satisfies SCMViewSortKey;
		}
	});
}

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

ViewsRegistry.registerViewWelcomeContent(VIEW_PANE_ID, {
	content: localize('scm.welcome.noProviders', 'No source control providers registered.'),
	when: 'default',
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'scm',
	when: FocusedViewContext.isEqualTo(VIEW_PANE_ID),
	getProvider: accessor => {
		const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement as HTMLElement;
		if ([...accessor.get(ISCMService).repositories].length > 0) {
			const pane = accessor.get(IViewsService).getViewWithId<ScmViewPane>(VIEW_PANE_ID);
			if (!pane?.isBodyVisible() || !pane.hasFocus()) return undefined;
			// The tree owns the instructions; the help dialog resolves the user's bindings when displayed.
			const description = pane.element.querySelector('[role="tree"]')?.getAttribute('aria-description');
			if (!description) return undefined;
			const content = description
				.replaceAll('workbench.scm.action.focusPreviousResourceGroup', '<keybinding:workbench.scm.action.focusPreviousResourceGroup>')
				.replaceAll('workbench.scm.action.focusNextResourceGroup', '<keybinding:workbench.scm.action.focusNextResourceGroup>');
			return new AccessibleContentProvider(AccessibleViewProviderId.Scm, { type: AccessibleViewType.Help }, () => content, () => {
				const active = focused.ownerDocument.activeElement;
				if (!pane.isDisposed && pane.isBodyVisible() && isFocusable(focused) && (active === focused.ownerDocument.body || pane.element.contains(active))) {
					restoreFocus(focused);
				}
			}, AccessibilityVerbositySettingId.Scm);
		}
		return new AccessibleContentProvider(AccessibleViewProviderId.Scm, { type: AccessibleViewType.Help },
			() => localize('scm.welcome.help', 'Source control has no repositories yet. Open a folder containing a Git repository, clone a repository when available, or initialize a repository in an open folder. Use Tab and Shift+Tab to move between the available buttons. Press Enter or Space to run an action. Once a repository is available, this view shows its changes.'),
			() => restoreFocus(focused), AccessibilityVerbositySettingId.Scm);
	},
});
type ScmWorkingSetDefault = 'current' | 'empty';

configurationRegistry.registerConfiguration<boolean>({
	key: 'scm.workingSets.enabled',
	defaultValue: false,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('scm.workingSets.enabled must be a boolean');
		return value;
	},
});
configurationRegistry.registerConfiguration<ScmWorkingSetDefault>({
	key: 'scm.workingSets.default',
	defaultValue: 'current',
	parse(value: unknown): ScmWorkingSetDefault {
		if (value !== 'current' && value !== 'empty') throw new TypeError('scm.workingSets.default must be current or empty');
		return value;
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 110,
	name: 'scmInput',
	when: ContextKeyExpr.has('scmInputIsFocused'),
	getProvider: accessor => {
		const document = accessor.get(ILayoutService).mainContainer.ownerDocument;
		const focused = document.activeElement as HTMLElement;
		return new AccessibleContentProvider(AccessibleViewProviderId.ScmInput, { type: AccessibleViewType.Help },
			() => localize('scm.input.help', 'Type a commit message. Enter inserts a new line. Ctrl+Enter on Windows and Linux, or Command+Enter on macOS, commits staged changes. Tab moves to the Commit button; Shift+Tab moves to the previous control. The Commit menu offers staged changes or all changes; Commit All asks whether to include untracked files. Sign-off adds a Signed-off-by trailer using your Git identity. Amend replaces the last commit after confirmation and uses its message when this draft is empty. Undo Last Commit keeps the changes staged and restores its complete message only to an unchanged empty draft. Failed commits keep the draft and show the actual index; successful commits preserve any newer draft. Use the editor shortcuts to select, copy, paste, undo and redo. The input grows with its content up to ten lines and then scrolls. Each repository keeps its own draft. Escape closes this help and returns to the commit message.'),
			() => restoreFocus(focused), AccessibilityVerbositySettingId.ScmInput);
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: 'scmRepositories',
		when: FocusedViewContext.isEqualTo(REPOSITORIES_VIEW_PANE_ID),
		getProvider: accessor => {
			const document = accessor.get(ILayoutService).mainContainer.ownerDocument;
			const focused = document.activeElement as HTMLElement;
			const list = document.querySelector<HTMLElement>('.ash-scm-repositories-list')!;
			const content = type === AccessibleViewType.Help
				? localize('scm.repositories.help', 'Repositories lists the source control repositories and worktrees available in this workspace. Use Up and Down Arrow to navigate, and Enter or Space to select a repository. Selection updates Changes, Graph and the status bar. Click the branch name in the status bar to switch branches. Each row shows the repository name, branch and changed file count. Repositories with the same name also show a distinguishing path.')
				: [...list.querySelectorAll<HTMLElement>('[role="option"]')].map(row => row.getAttribute('aria-label')).join('\n');
			return new AccessibleContentProvider(AccessibleViewProviderId.ScmRepositories, { type }, () => content, () => restoreFocus(focused), AccessibilityVerbositySettingId.ScmRepositories);
		},
	});
}

registerWorkbenchContribution('workbench.contrib.scmRepositories', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	const scm = accessor.get(ISCMService);
	const contextKeyService = accessor.get(IContextKeyService);
	const count = contextKeyService.createKey<number>('scm.providerCount', 0);
	const historyCount = contextKeyService.createKey<number>('scm.historyProviderCount', 0);
	const update = (): void => {
		const repositories = [...scm.repositories];
		contextKeyService.bufferChangeEvents(() => {
			count.set(repositories.length);
			historyCount.set(repositories.filter(repository => repository.provider.historyProvider !== undefined).length);
		});
	};
	resources.add(toDisposable(() => contextKeyService.bufferChangeEvents(() => {
		count.reset();
		historyCount.reset();
	})));
	resources.add(scm.onDidAddRepository(update));
	resources.add(scm.onDidRemoveRepository(update));
	update();
	return resources;
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: 'scmHistoryDetails',
		when: ContextKeyExpr.has('scmHistoryDetailsFocused'),
		getProvider: accessor => {
			const document = accessor.get(ILayoutService).mainContainer.ownerDocument;
			const card = document.activeElement!.closest<HTMLElement>('.ash-scm-graph-hover')!;
			const tooltip = card.closest<HTMLElement>('.ash-hover')!;
			const commit = document.querySelector<HTMLElement>(`[aria-describedby~="${tooltip.id}"]`)!;
			// Opening the modal dismisses the hover, so capture its readable content and return target first.
			const content = type === AccessibleViewType.Help
				? localize('scm.history.detailsHelp', 'Commit details show the author, relative and full time, complete message, and file and line change counts. Use Left and Right Arrow in the actions toolbar to copy the full commit ID or open the commit in a browser. Use Tab and Shift+Tab to move between the message and actions within the details card. Escape returns to the commit. Press <keybinding:editor.action.accessibleView> to read these details as plain text.')
				: `${card.innerText}\n${card.querySelector<HTMLElement>('.ash-scm-graph-hover-hash')!.title}`;
			return new AccessibleContentProvider(AccessibleViewProviderId.ScmHistoryDetails, { type }, () => content, () => restoreFocus(commit), AccessibilityVerbositySettingId.ScmHistoryDetails);
		},
	});
}

export const GIT_AGENT_REVIEW_VIEW_ID = "ash.gitAgentReview";
export const GIT_GRAPH_VIEW_ID = 'ash.gitGraph';

registerWorkbenchContribution('workbench.contrib.scmActivity', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(SCMActiveRepositoryController));

registerAction2(class SCMHistoryRefreshAction extends Action2 {
	constructor() {
		super({
			id: 'ash.git.graph.refresh',
			title: localize2({ bundle: 'ash', key: 'library.refresh' }, 'Refresh'),
			tooltip: 'Refresh SCM history',
			icon: Lxicon.refresh,
			precondition: SCMHistoryBusyContext.isEqualTo(false),
			menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 4 },
		});
	}

	override async run(_accessor: ServicesAccessor, target: unknown): Promise<void> {
		if (target instanceof SCMHistoryViewPane) await target.runTitleOperation();
	}
});

registerEditorPane({
	id: SCM_MERGE_EDITOR_ID,
	name: localize({ bundle: 'ash', key: 'git.mergeTitle' }, 'Resolve merge conflict'),
	canOpen: matchScmMergeEditor,
	create: options => {
		if (!options.textFileService || !options.instantiationService) throw new Error('SCM merge editor requires the text file and instantiation services');
		const instantiationService = options.instantiationService;
		const resultEditor = instantiationService.createInstance(TextFileEditor, getBrowserTextResourceStore(options.textFileService), {
			createPart: (partOptions: EditorPanePartOptions) => createBrowserEditorPart(instantiationService, partOptions),
			minimap: { enabled: false },
			workingCopyService: options.workingCopyService,
			accessibilityService: options.accessibilityService,
			textMateService: options.textMateService,
			languageDiagnosticsService: options.languageDiagnosticsService,
		});
		return instantiationService.createInstance(ScmMergeEditorPane, resultEditor);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'scmMergeHelp',
	when: ScmMergeFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof ScmMergeEditorPane)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.ScmMerge,
			{ type: AccessibleViewType.Help },
			() => localize({ bundle: 'ash', key: 'git.mergeHelp' }, 'Merge editor. Review aligned Current, Incoming, and Result editors. Show Base reveals the common ancestor; Use Columns changes the layout. Actions beside each conflict accept Base, Current, Incoming, or a combination. Mark Handled confirms a result that was already edited; Mark Unhandled returns it to the review list. Navigate all conflicts or only unresolved conflicts with the buttons above, or accept all remaining conflicts from one side. You can also edit Result directly. For deleted or binary versions, choose the whole file. Save with Ctrl+S or Command+S. Complete Merge saves and stages the result after every conflict is handled and all conflict markers are removed. Press <keybinding:editor.action.accessibleView> to read all four versions.'),
			() => pane.focus(),
			AccessibilityVerbositySettingId.ScmMerge,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'scmMergeView',
	when: ScmMergeFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof ScmMergeEditorPane)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.ScmMerge,
			{ type: AccessibleViewType.View },
			() => pane.getAccessibleContent(),
			() => pane.focus(),
			AccessibilityVerbositySettingId.ScmMerge,
		);
	},
});

/** Registers the Git Sidebar container and its initial pane. */
export function registerGitViews(
	registry: WorkbenchViewRegistry = ViewsRegistry,
): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Git,
		title: "Git",
		localizationKey: { bundle: "ash.views", key: "git" },
		location: ViewContainerLocation.Sidebar,
		ctorDescriptor: new SyncDescriptor(SCMViewPaneContainer),
		icon: Lxicon.gitBranch,
		order: 3,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Git, [
		{
			id: REPOSITORIES_VIEW_PANE_ID,
			title: 'Repositories',
			localizationKey: { bundle: 'ash.views', key: 'repositories' },
			order: 0,
			when: ContextKeyExpr.and(ContextKeyExpr.has('scm.providerCount'), ContextKeyExpr.notEquals('scm.providerCount', 1)),
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(SCMRepositoriesViewPane),
		},
		{
			id: VIEW_PANE_ID,
			title: "Changes",
			localizationKey: { bundle: "ash.views", key: "changes" },
			order: 1,
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(ScmViewPane),
		},
		{
			id: GIT_AGENT_REVIEW_VIEW_ID,
			title: "Agent Review",
			localizationKey: { bundle: "ash.views", key: "agentReview" },
			order: 2,
			when: ContextKeyExpr.greater('scm.providerCount', 0),
			collapsed: true,
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(ScmAgentReviewViewPane),
		},
		{
			id: GIT_GRAPH_VIEW_ID,
			title: "Graph",
			localizationKey: { bundle: "ash.views", key: "graph" },
			order: 3,
			when: ContextKeyExpr.greater('scm.historyProviderCount', 0),
			collapsed: true,
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(SCMHistoryViewPane),
		},
	]);
}

registerWorkbenchContribution("workbench.contrib.scmStatus", WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ScmStatusContribution));

registerWorkbenchContribution("workbench.contrib.scmWorkingSets", WorkbenchPhase.BlockRestore, accessor => new ScmWorkingSetController({
	configurationService: accessor.get(IConfigurationService),
	editorPart: accessor.get(IEditorPart),
	scmViewService: accessor.get(ISCMViewService),
	storageService: accessor.get(IStorageService),
}));

registerWorkbenchContribution("workbench.contrib.scmHistoryChatContext", WorkbenchPhase.BlockRestore, accessor => new ScmHistoryChatContextContribution(
	accessor.get(IChatContextPickService),
	accessor.get(ISCMService),
));
