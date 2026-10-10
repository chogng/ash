import type { IResourceEditorInput } from '../../../../common/editor.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { isMultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { ActivityService } from '../../../../services/activity/browser/activityService.js';
import { IActivityService } from '../../../../services/activity/common/activity.js';
import type { CompositeBar } from '../../../../browser/parts/compositeBar.js';
import { SCMActiveRepositoryController } from '../../browser/activity.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { IDecorationsService } from '../../../../services/decorations/common/decorations.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../../../nls.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { noFileIconTheme } from '../../../../../platform/theme/common/themeService.js';
import assert from "node:assert/strict";
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { observableValue } from '../../../../../base/common/observable.js';
import type { ISCMHistoryProvider } from '../../common/history.js';
import { DialogResult, type IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

import { suite, test } from "mocha";
import { JSDOM } from "jsdom";
import type { IContextMenuDelegate } from "../../../../../base/browser/contextmenu.js";
import { AnchorAxisAlignment, AnchorPosition } from "../../../../../base/common/layout.js";
import { URI } from "../../../../../base/common/uri.js";
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { IMenuService, MenuId, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import { CommandsRegistry, ICommandService } from "../../../../../platform/commands/common/commands.js";
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IContextMenuService, IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import { BrowserContextMenuService, transformContextMenuDelegate } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import type { HoverSetupOptions, IHoverService, IManagedHover } from "../../../../../platform/hover/browser/hoverService.js";
import { IResourceLabelService, ResourceLabels, DEFAULT_LABELS_CONTAINER, IResourceIconRenderer } from "../../../../browser/labels.js";
import { GitWorkspaceError, IGitService, type GitCommitDetails, type GitRepository, type GraphQuery, type GitStatus } from "../../../../../workbench/contrib/git/common/gitService.js";
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from "../../../../../workbench/services/editor/common/editorService.js";
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { WorkbenchState, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { CommandService } from "../../../../../workbench/services/commands/common/commandService.js";
import { OpenScmMultiDiffEditorAction } from "../../../../../workbench/contrib/multiDiffEditor/browser/scmMultiDiffAction.js";
import { resolveGitChangeInputs } from '../../../git/browser/gitChangeEditorInput.js';
import { isScmMergeEditorInput } from "../../../../../workbench/contrib/scm/browser/scmMergeEditorInput.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { GitHistoryProvider } from '../../../git/browser/gitHistoryProvider.js';
import { GitSCMContribution, GitSCMProvider, type GitSCMProviderServices } from '../../../git/browser/gitSCMProvider.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { SCMRepositoriesViewPane } from '../../browser/scmRepositoriesViewPane.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ISCMService, ISCMViewService, VIEW_PANE_ID, type ISCMProvider } from '../../common/scm.js';
import type { ScmViewPane } from '../../browser/scmViewPane.js';
import type { ISCMResourceGroup } from '../../common/scm.js';

const testDialogs: IDialogService = {
	onWillShowDialog: Event.None,
	onDidShowDialog: Event.None,
	about: async () => { throw new Error('Unexpected about dialog'); },
	showMessage: async () => { },
	info: async () => { },
	warn: async () => { },
	error: async () => { },
	confirm: async () => ({ confirmed: true }),
	prompt: async () => { throw new Error('Unexpected prompt'); },
	input: async () => ({ confirmed: false }),
};

function createHistoryViewFixture(gitService: IGitService): DisposableStore & { readonly viewService: SCMViewService; } {
	const resources = new DisposableStore();
	const scmService = resources.add(new SCMService());
	const viewService = resources.add(new SCMViewService(scmService));
	const provider = resources.add(new GitHistoryProvider({
		...gitService,
		onDidChangeRepositoryStatus: gitService.onDidChangeRepositoryStatus ?? noEvent,
		onDidBecomeReady: gitService.onDidBecomeReady ?? noEvent,
	}, 'repo-1'));
	resources.add(scmService.registerSCMProvider(testSCMProvider('repo-1', 'workspace', provider)));
	return Object.assign(resources, { viewService });
}

test('Git history contribution registers repositories and follows active repository changes', () => {
	using resources = new DisposableStore();
	const scmService = resources.add(new SCMService());
	const viewService = resources.add(new SCMViewService(scmService));
	const repositoriesChanged = resources.add(new Emitter<readonly GitRepository[]>());
	const activeChanged = resources.add(new Emitter<GitRepository | undefined>());
	const main = { id: 'main', label: 'main', path: '/main', root: URI.file('/main') };
	const secondary = { id: 'secondary', label: 'secondary', path: '/secondary', root: URI.file('/secondary') };
	let repositories: readonly GitRepository[] = [main, secondary];
	let activeRepository: GitRepository | undefined = secondary;
	const gitService = {
		get repositories() { return repositories; },
		get activeRepository() { return activeRepository; },
		onDidChangeRepositories: repositoriesChanged.event,
		onDidChangeActiveRepository: activeChanged.event,
		onDidChangeRepositoryStatus: Event.None,
		onDidBecomeReady: Event.None,
	} as IGitService;
	const decorationDocument = new JSDOM('<!doctype html><head></head><body></body>');
	resources.add(toDisposable(() => decorationDocument.window.close()));
	const decorationServices = resources.add(createTestEditorServices(undefined, undefined, decorationDocument.window.document));
	resources.add(new GitSCMContribution(gitService, scmService, viewService, testGitProviderServices(), decorationServices.get(IDecorationsService)));

	assert.deepEqual([...scmService.repositories].map(repository => repository.id), ['main', 'secondary']);
	assert.equal(viewService.activeRepository?.id, 'secondary');
	assert.ok(scmService.getRepository('main')?.provider.historyProvider instanceof GitHistoryProvider);

	activeRepository = main;
	activeChanged.fire(main);
	assert.equal(viewService.activeRepository?.id, 'main');

	repositories = [secondary];
	activeRepository = secondary;
	repositoriesChanged.fire(repositories);
	assert.deepEqual([...scmService.repositories].map(repository => repository.id), ['secondary']);
	assert.equal(viewService.activeRepository?.id, 'secondary');
	using other = scmService.registerSCMProvider({ ...testSCMProvider('other', 'other', {} as GitHistoryProvider), providerId: 'other' });
	viewService.selectRepository('other');
	activeRepository = undefined;
	activeChanged.fire(undefined);
	assert.equal(viewService.activeRepository?.id, 'other');
});

test('SCM history services assemble through their production registrations', async () => {
	await import('../../browser/scm.service.contribution.js');
	using services = new InstantiationService();
	for (const [id, descriptor] of getSingletonServiceDescriptors()) {
		if (id === ISCMService || id === ISCMViewService) services.registerSingleton(id, () => services.createInstance(descriptor));
	}
	assert.ok(services.has(ISCMService));
	assert.ok(services.has(ISCMViewService));
	const scmService = services.get(ISCMService);
	const viewService = services.get(ISCMViewService);
	using repository = scmService.registerSCMProvider(testSCMProvider('repo', 'repo', {} as GitHistoryProvider));
	assert.equal(viewService.activeRepository?.id, 'repo');
});

test("SCM diff inputs open live files and keep deleted files on the readable side", async () => {
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-input-stream",
		revision: 1,
		workspacePath: "/workspace",
		head: { type: "branch", name: "main", objectId: "1234567890", upstream: undefined },
		changes: [],
	};
	const gitService = {
		changeFile: async (path: string) => path.endsWith("deleted.ts")
			? { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "missing" as const } }
			: { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "text" as const, text: "after\n" } },
	} as unknown as IGitService;
	const live = await resolveGitChangeInputs(gitService, status, change("src/working.ts", "unmodified", "modified"), "unstaged");
	const deleted = await resolveGitChangeInputs(gitService, status, change("src/deleted.ts", "unmodified", "deleted"), "unstaged");

	assert.equal(live.goToFile?.resource.toString(), "file:///workspace/src/working.ts");
	assert.equal(deleted.goToFile, deleted.original);
});

test('SCM Open File actions open editable working files from each group and skip deleted files', async () => {
	const status: GitStatus = {
		repositoryId: 'repo-1', streamInstanceId: 'open-file-stream', revision: 1,
		workspacePath: '/workspace/nested',
		head: { type: 'branch', name: 'main', objectId: '1234567890', upstream: undefined },
		changes: [
			change('staged.ts', 'modified', 'unmodified'),
			{ ...change('new.ts', 'renamed', 'modified'), originalPath: 'old.ts' },
			{ ...change('conflict.ts', 'unmerged', 'unmerged'), conflicted: true },
			change('deleted.ts', 'unmodified', 'deleted'),
			change('staged-deleted.ts', 'deleted', 'unmodified'),
			change('both-deleted.ts', 'modified', 'deleted'),
		],
	};
	const repository = { id: status.repositoryId, label: 'nested', path: 'nested', root: URI.file(status.workspacePath) };
	const gitService = {
		status: async () => status,
		onDidChangeRepositoryStatus: Event.None,
		onDidBecomeReady: Event.None,
	} as unknown as IGitService;
	const opened: Array<{ readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target?: EditorOpenTarget; }> = [];
	using provider = new GitSCMProvider(gitService, repository, {} as GitHistoryProvider, testGitProviderServices({ editorService: testEditorService(opened) }));
	await waitFor(() => provider.groups.length === 3);
	for (const group of provider.groups) {
		for (const resource of group.resources) {
			const action = resource.actions.find(action => action.id === `scm.change.openFile.${resource.path}`);
			if (resource.path.endsWith('deleted.ts')) {
				assert.equal(action, undefined);
				continue;
			}
			assert.ok(action);
			const count = opened.length;
			action.run();
			await waitFor(() => !provider.isBusy && opened.length === count + 1);
			assert.deepEqual(opened.at(-1), {
				input: { resource: URI.file(`${status.workspacePath}/${resource.path}`) },
				options: { pinned: false, revealIfOpened: true, preserveFocus: false }, target: undefined,
			});
		}
	}
});

test("Git contribution registers Repositories before Changes and hides it for a single provider", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);

	try {
		const { WorkbenchViewRegistry, WorkbenchViewContainerId } = await import("../../../../../workbench/common/views.js");
		const { GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID, registerGitViews } = await import("../../../../../workbench/contrib/scm/browser/scm.contribution.js");
		using registry = new WorkbenchViewRegistry();

		registerGitViews(registry);

		const views = registry.getViews(WorkbenchViewContainerId.Git);
		assert.deepEqual(views.map((view) => view.id), ['workbench.scm.repositories', VIEW_PANE_ID, GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID]);
		assert.deepEqual(views.map((view) => view.title), ['Repositories', "Changes", "Agent Review", "Graph"]);
		assert.deepEqual(views.map((view) => view.collapsed === true), [false, false, true, true]);
		const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
		using context = new ContextKeyService();
		const providerCount = context.createKey<number>('scm.providerCount', 0);
		assert.deepEqual([0, 1, 2].map(count => {
			providerCount.set(count);
			return views[0].when!.evaluate(context);
		}), [false, false, true]);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test('SCM panes follow repository and history availability through the window contribution', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	try {
		const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
		const { IContextKeyService } = await import('../../../../../platform/contextkey/common/contextkey.js');
		const { WorkbenchContributionsRegistry, WorkbenchPhase } = await import('../../../../common/contributions.js');
		const { WorkbenchViewRegistry, WorkbenchViewContainerId } = await import('../../../../common/views.js');
		const { ViewContainerModel } = await import('../../../../services/views/common/viewContainerModel.js');
		const { GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID, registerGitViews } = await import('../../browser/scm.contribution.js');
		using context = new ContextKeyService();
		using scm = new SCMService();
		using services = new InstantiationService();
		services.registerInstance(IContextKeyService, context);
		services.registerInstance(ISCMService, scm);
		using registry = new WorkbenchViewRegistry();
		registerGitViews(registry);
		using model = new ViewContainerModel(registry.getViewContainer(WorkbenchViewContainerId.Git)!, registry, context);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.scmRepositories']);
		host.advance(WorkbenchPhase.BlockRestore);
		const visiblePanes = (): readonly string[] => model.visibleViewDescriptors.map(view => view.id);
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);

		using repository = scm.registerSCMProvider(testSCMProvider('resources', 'Resources'));
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID, GIT_AGENT_REVIEW_VIEW_ID]);
		using history = new GitHistoryProvider({ onDidChangeRepositoryStatus: Event.None, onDidBecomeReady: Event.None } as unknown as IGitService, 'history');
		using historyRepository = scm.registerSCMProvider(testSCMProvider('history', 'History', history));
		assert.deepEqual(visiblePanes(), ['workbench.scm.repositories', VIEW_PANE_ID, GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID]);

		historyRepository.dispose();
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID, GIT_AGENT_REVIEW_VIEW_ID]);
		repository.dispose();
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);

		using restoredRepository = scm.registerSCMProvider(testSCMProvider('restored', 'Restored', history));
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID, GIT_AGENT_REVIEW_VIEW_ID, GIT_GRAPH_VIEW_ID]);
		host.dispose();
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);
		using afterDisposal = scm.registerSCMProvider(testSCMProvider('after-disposal', 'After disposal', history));
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("SCMHistoryViewPane renders a repository history page", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	await import('../../browser/scm.contribution.js');
	await import('../../../git/browser/git.contribution.js');
	const graphRequests: GraphQuery[] = [];
	const detailRequests: string[] = [];
	let delayedDetails: Promise<GitCommitDetails> | undefined;
	let detailsError: Error | undefined;
	const [
		{ ContextKeyService },
		{ MenuService },
		{ InstantiationService },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import('../../../../../platform/instantiation/common/instantiationService.js'),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const services = new InstantiationService();
	const menuService = new MenuService(new CommandService(services), contextKeyService);
	const hoverOptions: HoverSetupOptions[] = [];
	const graphRepositoryIds: Array<string | undefined> = [];
	const remoteRepositoryIds: Array<string | undefined> = [];
	const readyChanges = new Emitter<void>();
	let workspaceError: GitWorkspaceError | undefined;
	let readySubscriptions = 0;
	const hoverService: IHoverService = {
		setupDelayedHover: () => testManagedHover(),
		setupHover: (options) => {
			hoverOptions.push(options);
			return testManagedHover();
		},
		showHover: () => testManagedHover(),
		hideHover() { },
	};
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "main", objectId: "1234567890abcdef", upstream: { name: "origin/main", ahead: 0, behind: 0 } },
		changes: [],
	};
	const gitService = {
		getRepository: async (repositoryId: string) => ({ id: repositoryId }),
		catalog: async () => ({ tags: [], stashes: [], remotes: ['origin'], operation: undefined }),
		onDidBecomeReady: (listener: () => void) => {
			readySubscriptions += 1;
			return readyChanges.event(listener);
		},
		status: async (repositoryId?: string) => {
			if (workspaceError) throw workspaceError;
			assert.equal(repositoryId, "repo-1");
			return status;
		},
		commitDetails: async (id: string, repositoryId?: string) => {
			detailRequests.push(id);
			assert.equal(repositoryId, 'repo-1');
			if (detailsError) { throw detailsError; }
			if (delayedDetails) { return delayedDetails; }
			return { authorName: 'History Author', authorEmail: 'author@example.invalid', timestampSeconds: 1_753_000_000, message: 'Wire SCM panes\n\n    Full explanation.', statistics: { files: 3, additions: 12, deletions: 4 } };
		},
		branches: async () => [],
		graph: async (query: GraphQuery, repositoryId?: string) => {
			if (workspaceError) throw workspaceError;
			graphRequests.push(query);
			graphRepositoryIds.push(repositoryId);
			return {
				commits: [
					{ objectId: "1234567890abcdef", parentObjectIds: ["abcdef1234567890", "side-parent"], timestampSeconds: 1_753_000_000, subject: "Wire SCM panes" },
					{ objectId: "abcdef1234567890", parentObjectIds: ["parent-one", "parent-two"], timestampSeconds: 1_752_900_000, subject: "Prepare graph data" },
				],
				references: [
					{ name: "main", objectId: "1234567890abcdef", kind: "localBranch", remoteName: undefined, current: true },
					{ name: "origin/main", objectId: "abcdef1234567890", kind: "remoteBranch", remoteName: "origin", current: false },
					{ name: "origin/release", objectId: "abcdef1234567890", kind: "remoteBranch", remoteName: "origin", current: false },
					{ name: "topic", objectId: "abcdef1234567890", kind: "localBranch", remoteName: undefined, current: false },
					{ name: "feature", objectId: "abcdef1234567890", kind: "localBranch", remoteName: undefined, current: false },
					{ name: "reviewed", objectId: "abcdef1234567890", kind: "tag", remoteName: undefined, current: false },
				],
				remotes: [{ name: "origin", identity: { provider: "github", host: "github.com", owner: "chogng", repository: "ash" } }],
				hasMore: false,
				nextCursor: undefined,
			};
		},
		fetch: async (repositoryId?: string) => {
			remoteRepositoryIds.push(repositoryId);
			return status;
		},
	} as unknown as IGitService;
	services.registerInstance(IGitService, gitService);
	using fetchNotifications = new NotificationService();
	services.registerInstance(INotificationService, fetchNotifications);

	try {
		using history = createHistoryViewFixture(gitService);
		const { SCMHistoryViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js");
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.test", title: "Graph" }, history.viewService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } });
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelectorAll(".ash-scm-graph-commit").length === 2);
		assert.equal(pane.element.querySelector('[role="tree"]')?.getAttribute('aria-label'), 'Graph');
		assert.equal(readySubscriptions, 1);

		const remoteActionItems = [...pane.element.querySelectorAll<HTMLElement>(".ash-pane-view-header-actions .ash-action-view-item")];
		assert.deepEqual(remoteActionItems.map((item) => item.dataset.actionId), ["git.fetchAll", "ash.git.pull", "ash.git.push", "ash.git.graph.refresh"]);
		assert.equal(remoteActionItems.filter((item) => item.querySelector(".ash-icon")).length, 4);
		pane.setCollapsed(true);
		assert.equal(pane.element.querySelector<HTMLElement>(".ash-pane-view-header-actions")?.hidden, true);
		pane.setCollapsed(false);
		assert.equal(pane.element.querySelector<HTMLElement>(".ash-pane-view-header-actions")?.hidden, false);

		const refresh = pane.element.querySelector<HTMLButtonElement>('[data-action-id="ash.git.graph.refresh"] > button');
		assert.ok(refresh);
		refresh.click();
		await waitFor(() => graphRequests.length === 2 && pane.element.querySelectorAll(".ash-scm-graph-subject").length === 2);
		assert.deepEqual(graphRequests, [{ limit: 50 }, { limit: 50 }]);
		assert.deepEqual(graphRepositoryIds, ["repo-1", "repo-1"]);

		assert.deepEqual([...pane.element.querySelectorAll(".ash-scm-graph-subject")].map((element) => element.textContent), ["Wire SCM panes", "Prepare graph data"]);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit.current")?.getAttribute("aria-current"), "true");
		assert.ok(pane.element.querySelector(".ash-scm-graph-commit.head"));
		assert.ok(pane.element.querySelector(".ash-scm-graph-commit.merge"));
		assert.ok(pane.element.querySelector(".ash-scm-graph-commit.head.merge"));
		assert.equal(pane.element.querySelector(".ash-scm-graph-label.head")?.textContent, "main");
		assert.ok(pane.element.querySelector(".ash-scm-graph-label.head .ash-icon"));
		assert.equal(pane.element.querySelector(".ash-scm-graph-label.remote")?.textContent, "2");
		assert.equal(pane.element.querySelector(".ash-scm-graph-label.remote")?.getAttribute('aria-label'), 'origin/main, origin/release');
		assert.equal(pane.element.querySelectorAll('.ash-scm-graph-label.remote').length, 1);
		assert.equal(pane.element.querySelector('.ash-scm-graph-label.local[data-icon="git-branch"]')?.textContent, '2');
		assert.equal(pane.element.querySelector('.ash-scm-graph-label.local[data-icon="git-branch"]')?.getAttribute('aria-label'), 'feature, topic');
		assert.equal(pane.element.querySelector<HTMLElement>(".ash-scm-graph-label.remote")?.dataset.icon, "cloud");
		assert.equal(pane.element.querySelector<HTMLElement>('.ash-scm-graph-label[aria-label="reviewed"]')?.dataset.icon, 'tag');
		assert.equal(pane.element.querySelector('.ash-scm-graph-remotes'), null);
		assert.ok(pane.element.querySelector('.ash-scm-graph > .ash-scm-graph-viewport .ash-list'));
		assert.equal(hoverOptions.length, 4);
		assert.ok(hoverOptions.every((options) => options.target.classList.contains("ash-scm-graph-commit")));
		assert.ok(hoverOptions.every((options) => options.anchorAxisAlignment === AnchorAxisAlignment.Horizontal));
		assert.ok(hoverOptions.every((options) => options.anchorPosition === AnchorPosition.Below));
		assert.equal(pane.element.querySelector(".ash-scm-graph-graph.head")?.querySelectorAll(".ash-scm-graph-node").length, 2);
		assert.ok(new Set([...pane.element.querySelectorAll<SVGPathElement>(".ash-scm-graph-path")].map((path) => path.dataset.laneColor)).size > 1);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit.head.merge > .ash-scm-graph-row > .ash-scm-graph-graph")?.classList.contains("head"), true);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit.head.merge > .ash-scm-graph-row > .ash-scm-graph-graph")?.classList.contains("merge"), false);
		assert.equal(pane.element.querySelectorAll(".ash-scm-graph-twistie").length, 0);
		assert.equal(pane.element.querySelector(".ash-scm-graph-graph.merge")?.querySelectorAll(".ash-scm-graph-node").length, 2);
		assert.equal(pane.element.querySelector<SVGSVGElement>(".ash-scm-graph-graph.merge")?.style.width, "44px");
		assert.ok((pane.element.querySelector(".ash-scm-graph-graph.merge")?.querySelectorAll(".ash-scm-graph-path").length ?? 0) > 1);
		assert.equal(pane.element.querySelector('.ash-scm-graph-metadata'), null);
		assert.deepEqual(detailRequests, []);
		const commitHover = hoverOptions.filter(options => options.target.classList.contains('current')).at(-1)!;
		const content = typeof commitHover.content === 'function' ? commitHover.content(CancellationToken.None) : commitHover.content;
		assert.ok(content instanceof browser.window.HTMLElement);
		assert.equal(content.querySelector('.ash-scm-graph-hover-subject')?.textContent, 'Wire SCM panes');
		await waitFor(() => content.querySelector('.ash-scm-graph-hover-details')?.getAttribute('aria-busy') === 'false');
		assert.deepEqual(detailRequests, ['1234567890abcdef']);
		assert.equal(content.querySelector('.ash-scm-graph-hover-author > span')?.textContent, 'History Author');
		assert.equal(content.querySelector('.ash-scm-graph-hover-message')?.textContent, '    Full explanation.');
		assert.equal(content.querySelector('time')?.getAttribute('datetime'), new Date(1_753_000_000_000).toISOString());
		assert.equal(content.querySelector('.ash-scm-graph-hover-hash')?.getAttribute('aria-label'), 'Commit 1234567890abcdef');
		assert.deepEqual([...content.querySelectorAll('.ash-scm-graph-hover-statistics > span')].map(element => element.textContent), ['3 files changed', '12 insertions(+)', '4 deletions(-)']);
		const copyHash = content.querySelector<HTMLButtonElement>('[data-action-id="git.graph.copyHash"] button')!;
		assert.equal(copyHash.getAttribute('aria-label'), 'Copy Commit Hash');
		assert.equal(copyHash.textContent, '');
		assert.equal(copyHash.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'), 'copy');
		const openRemote = content.querySelector<HTMLButtonElement>('[data-action-id="git.graph.openRemote"] button')!;
		assert.equal(openRemote.textContent, 'Open on GitHub');
		assert.equal(openRemote.querySelector('.ash-icon')?.getAttribute('data-ash-icon-id'), 'github');
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		try {
			const localized = (commitHover.content as (token: CancellationToken) => HTMLElement)(CancellationToken.None);
			assert.equal(localized.querySelector('[role="status"]')?.textContent, '正在读取提交详情…');
			await waitFor(() => localized.querySelector('.ash-scm-graph-hover-details')?.getAttribute('aria-busy') === 'false');
			assert.deepEqual([...localized.querySelectorAll('.ash-scm-graph-hover-statistics > span')].map(element => element.textContent), ['修改了 3 个文件', '新增 12 行（+）', '删除 4 行（-）']);
			Object.defineProperty(browser.window.Element.prototype, 'scrollTo', { configurable: true, value() { } });
			services.registerInstance(ILayoutService, { mainContainer: browser.window.document.body } as ILayoutService);
			const tooltip = browser.window.document.createElement('div');
			tooltip.className = 'ash-hover';
			tooltip.id = 'test-scm-details';
			tooltip.append(localized);
			browser.window.document.body.append(tooltip);
			commitHover.target.setAttribute('aria-describedby', tooltip.id);
			localized.querySelector<HTMLButtonElement>('button')!.focus();
			const help = AccessibleViewRegistry.getImplementations().find(implementation => implementation.name === 'scmHistoryDetails' && implementation.type === AccessibleViewType.Help)!;
			using provider = help.getProvider(services)!;
			assert.match(provider.provideContent(), /完整提交说明/);
			provider.dispose();
			assert.equal(browser.window.document.activeElement, commitHover.target);
			tooltip.remove();
			commitHover.target.removeAttribute('aria-describedby');
			detailsError = new Error('Git command failed');
			const failed = (commitHover.content as (token: CancellationToken) => HTMLElement)(CancellationToken.None);
			await waitFor(() => failed.querySelector('.ash-scm-graph-hover-details')?.getAttribute('aria-busy') === 'false');
			assert.equal(failed.querySelector('[role="status"]')?.textContent, '无法读取提交详情。');
			assert.equal(failed.querySelector('.ash-scm-graph-hover-statistics'), null);
		} finally {
			resetNlsResolver();
			detailsError = undefined;
		}
		const delayed = new DeferredPromise<GitCommitDetails>();
		delayedDetails = delayed.p;
		using retiredContent = new CancellationTokenSource();
		const retired = (commitHover.content as (token: CancellationToken) => HTMLElement)(retiredContent.token);
		retiredContent.cancel();
		const replacement = (commitHover.content as (token: CancellationToken) => HTMLElement)(CancellationToken.None);
		await delayed.complete({ authorName: 'Late author', authorEmail: '', timestampSeconds: 1_753_000_000, message: 'Wire SCM panes', statistics: { files: 0, additions: 0, deletions: 0 } });
		await waitFor(() => replacement.querySelector('.ash-scm-graph-hover-details')?.getAttribute('aria-busy') === 'false');
		assert.equal(retired.querySelector('.ash-scm-graph-hover-author'), null, 'A replaced card ignores its pending details result');
		delayedDetails = undefined;

		const fetch = pane.element.querySelector<HTMLButtonElement>('[data-action-id="git.fetchAll"] > button');
		assert.ok(fetch);
		fetch.click();
		await waitFor(() => remoteRepositoryIds.length === 1 && graphRequests.length === 3);
		assert.deepEqual(remoteRepositoryIds, ["repo-1"]);
		assert.equal(readySubscriptions, 1);

		workspaceError = new GitWorkspaceError('noFolder');
		readyChanges.fire();
		await waitFor(() => pane.element.querySelector('.ash-scm-empty')?.textContent === 'Open a folder to use Git.');
		assert.equal(pane.element.querySelectorAll('.ash-scm-graph-commit').length, 0);
		assert.equal(pane.element.querySelector('.ash-scm-graph .ash-scm-command'), null);

		workspaceError = undefined;
		readyChanges.fire();
		await waitFor(() => pane.element.querySelectorAll('.ash-scm-graph-commit').length === 2);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test('SCM history title operations keep refresh and busy state with their starting repository', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	try {
		const { SCMHistoryViewPane } = await import('../../browser/scmHistoryViewPane.js');
		const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
		const { MenuService } = await import('../../../../../platform/actions/common/menuService.js');
		using context = new ContextKeyService();
		using services = new InstantiationService();
		const menus = new MenuService(new CommandService(services), context);
		using scm = new SCMService();
		using view = new SCMViewService(scm);
		const refreshed: string[] = [];
		const loaded: string[] = [];
		const provider = (id: string): ISCMHistoryProvider => ({
			onDidChange: Event.None,
			historyItemRef: observableValue('historyRef', undefined),
			refresh: () => { refreshed.push(id); },
			provideHistoryItems: async () => { loaded.push(id); return []; },
			resolveHistoryItemDetails: async () => { throw new Error('Unexpected details request'); },
			provideHistoryItemChanges: async () => [],
			resolveHistoryItemChangeContents: async () => { throw new Error('Unexpected content request'); },
			resolveHistoryItemChatContext: async () => undefined,
			resolveHistoryItemChangeRangeChatContext: async () => undefined,
		});
		using first = scm.registerSCMProvider(testSCMProvider('first', 'First', provider('first')));
		using second = scm.registerSCMProvider(testSCMProvider('second', 'Second', provider('second')));
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: 'history.operation.test', title: 'Graph' }, view, menus, {} as IContextMenuService, context, {
			setupDelayedHover: () => testManagedHover(),
			setupHover: () => testManagedHover(),
			showHover: () => testManagedHover(),
			hideHover() { },
		}, testEditorService(), testResourceLabelService(), {
			show: () => false,
			getOpenAriaHint: () => undefined,
			disableHint: async () => { },
			showAccessibleViewHelp: () => { },
			dispose() { },
			[Symbol.dispose]() { },
		}, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } });
		await waitFor(() => pane.element.querySelector('.ash-scm-empty') !== null);
		const firstOperation = new DeferredPromise<void>();
		const firstResult = pane.runTitleOperation(() => firstOperation.p);
		assert.equal(context.getValue('scmHistoryBusy'), true);
		view.selectRepository(second.id);
		assert.equal(context.getValue('scmHistoryBusy'), false);
		await waitFor(() => loaded.includes('second'));
		const secondOperation = new DeferredPromise<void>();
		const secondResult = pane.runTitleOperation(() => secondOperation.p);
		await firstOperation.complete();
		await firstResult;
		assert.deepEqual(refreshed, [], 'The retired operation does not refresh the newly selected repository');
		assert.equal(context.getValue('scmHistoryBusy'), true, 'The retired operation cannot enable another repository’s actions');
		await secondOperation.complete();
		await secondResult;
		assert.deepEqual({ refreshed, loaded, busy: context.getValue('scmHistoryBusy') }, {
			refreshed: ['second'], loaded: ['first', 'second', 'second'], busy: false,
		});
		const retiredOperation = new DeferredPromise<void>();
		const retiredResult = pane.runTitleOperation(() => retiredOperation.p);
		view.selectRepository(first.id);
		view.selectRepository(second.id);
		await retiredOperation.complete();
		await retiredResult;
		assert.deepEqual(refreshed, ['second'], 'Switching back does not revive an operation retired by a repository switch');
		await assert.rejects(pane.runTitleOperation(async () => { throw new Error('Fetch failed'); }), /Fetch failed/);
		assert.equal(context.getValue('scmHistoryBusy'), false, 'A failed operation releases its own busy state');
		const disposedOperation = new DeferredPromise<void>();
		const disposedResult = pane.runTitleOperation(() => disposedOperation.p);
		pane.dispose();
		await disposedOperation.complete();
		await disposedResult;
		assert.deepEqual(refreshed, ['second'], 'A disposed pane no longer refreshes its provider');
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("SCMHistoryViewPane loads another history page only on demand", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const graphRequests: GraphQuery[] = [];
	const [
		{ ContextKeyService },
		{ MenuService },
		{ InstantiationService },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import('../../../../../platform/instantiation/common/instantiationService.js'),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const menuService = new MenuService(new CommandService(new InstantiationService()), contextKeyService);
	const hoverService: IHoverService = {
		setupDelayedHover: () => testManagedHover(),
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() { },
	};
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "main", objectId: "commit-1", upstream: undefined },
		changes: [],
	};
	const gitService = {
		onDidBecomeReady: noEvent,
		onDidChangeActiveRepository: noEvent,
		status: async () => status,
		branches: async () => [],
		graph: async (query: GraphQuery) => {
			graphRequests.push(query);
			const start = query.cursor ? Number(query.cursor) : 0;
			const commits = Array.from({ length: Math.min(50, 101 - start) }, (_, index) => ({
				objectId: `commit-${start + index + 1}`,
				parentObjectIds: start + index === 100 ? [] : [`commit-${start + index + 2}`],
				timestampSeconds: 1_753_000_000 - start - index,
				subject: `History item ${start + index + 1}`,
			}));
			return {
				commits,
				references: [],
				remotes: [],
				hasMore: start < 100,
				nextCursor: start < 100 ? String(start + 50) : undefined,
			};
		},
	} as unknown as IGitService;

	try {
		using history = createHistoryViewFixture(gitService);
		const { SCMHistoryViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js");
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.pagination.test", title: "Graph" }, history.viewService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } });
		pane.setVisible(true);
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector('.ash-scm-graph .ash-list') !== null);
		const list = pane.element.querySelector('.ash-scm-graph .ash-list');
		const graph = pane.element.querySelector<HTMLElement>('.ash-scm-graph')!;
		const viewport = graph.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		await waitFor(() => graph.getAttribute('aria-busy') === 'false');
		const first = list!.querySelector('.ash-scm-graph-commit');
		assert.equal(first?.getAttribute('aria-setsize'), '50');
		assert.deepEqual(graphRequests, [{ limit: 50 }, { limit: 50, cursor: '50' }]);
		assert.equal(pane.element.querySelector('.ash-scm-graph .ash-list'), list);

		viewport.scrollTop = 1100;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		await waitFor(() => graph.getAttribute('aria-busy') === 'false' && graphRequests.length === 3);
		assert.equal(list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize'), '100');
		assert.deepEqual(graphRequests, [{ limit: 50 }, { limit: 50, cursor: '50' }, { limit: 50, cursor: '100' }]);
		assert.equal(list!.querySelectorAll('.ash-scm-graph-commit').length < 100, true);

		viewport.scrollTop = 2178;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		await waitFor(() => list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize') === '101');
		assert.equal(list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize'), '101');
		assert.equal(pane.element.querySelector('.ash-scm-graph-load-more'), null);
		assert.equal(graphRequests.length, 3);
		assert.equal(pane.element.querySelector('.ash-scm-graph .ash-list'), list);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("SCMHistoryViewPane virtualizes loaded history rows", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let resizeCallback: ResizeObserverCallback | undefined;
	class TestResizeObserver {
		constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
		observe(): void { }
		unobserve(): void { }
		disconnect(): void { }
	}
	Object.defineProperty(browser.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
	Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
	const [
		{ ContextKeyService },
		{ MenuService },
		{ InstantiationService },
		{ CommandService },
	] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import('../../../../../platform/instantiation/common/instantiationService.js'),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const menuService = new MenuService(new CommandService(new InstantiationService()), contextKeyService);
	const status: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		revision: 1,
		workspacePath: ".",
		head: { type: "branch", name: "main", objectId: "commit-0", upstream: undefined },
		changes: [],
	};
	const commits = Array.from({ length: 100 }, (_, index) => ({
		objectId: `commit-${index}`,
		parentObjectIds: index === 99 ? [] : [`commit-${index + 1}`],
		timestampSeconds: 1_753_000_000 - index,
		subject: `Commit ${index}`,
	}));
	const gitService = {
		onDidBecomeReady: noEvent,
		onDidChangeActiveRepository: noEvent,
		status: async () => status,
		branches: async () => [],
		graph: async (_query: GraphQuery) => ({ commits, references: [], remotes: [], hasMore: false, nextCursor: undefined }),
	} as unknown as IGitService;
	const hoverTargets: HTMLElement[] = [];
	const hoverHandles = new Map<HTMLElement, IManagedHover>();
	const disposedHoverTargets = new Set<HTMLElement>();
	const hiddenHoverTargets = new Set<HTMLElement>();
	const hoverService: IHoverService = {
		setupDelayedHover: () => testManagedHover(),
		setupHover: options => {
			hoverTargets.push(options.target);
			const handle = Object.assign(toDisposable(() => disposedHoverTargets.add(options.target)), {
				visible: false,
				show() { this.visible = true; },
				hide() { this.visible = false; hiddenHoverTargets.add(options.target); },
				update() { },
			});
			hoverHandles.set(options.target, handle);
			return handle;
		},
		showHover: () => testManagedHover(),
		hideHover() { },
	};

	try {
		using history = createHistoryViewFixture(gitService);
		const { SCMHistoryViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js");
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.virtualized.test", title: "Graph" }, history.viewService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } });
		pane.setVisible(true);
		const graph = pane.element.querySelector<HTMLElement>(".ash-scm-graph");
		assert.ok(graph);
		Object.defineProperty(graph, "clientHeight", { configurable: true, value: 100 });
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelectorAll(".ash-scm-graph-commit").length > 0);
		const viewport = graph.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		viewport.scrollTop = 1100;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		await waitFor(() => graph.getAttribute('aria-busy') === 'false' && graph.querySelector<HTMLElement>('.ash-list')?.style.height === `${commits.length * 22}px`);
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new browser.window.Event('scroll'));

		const initialRows = pane.element.querySelectorAll(".ash-scm-graph-commit").length;
		assert.ok(initialRows < commits.length);
		assert.equal(graph.querySelector<HTMLElement>('.ash-list')!.style.height, `${commits.length * 22}px`);

		const firstCommit = pane.element.querySelector<HTMLElement>('.ash-scm-graph-commit')!;
		const firstToolbar = firstCommit.querySelector('.ash-scm-graph-actions')!;
		const hoverCount = hoverTargets.length;
		firstCommit.focus();
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.equal(pane.element.querySelector('.ash-scm-graph-commit'), firstCommit, 'Scrolling within the same range retains the row');
		assert.equal(hoverTargets.length, hoverCount, 'Unchanged rows do not create more hover handles');
		assert.ok(!disposedHoverTargets.has(firstCommit));
		assert.equal(browser.window.document.activeElement, firstCommit);

		Object.defineProperty(graph, "clientHeight", { configurable: true, value: 320 });
		resizeCallback?.([{ borderBoxSize: [{ inlineSize: 320, blockSize: 320 }], contentRect: { width: 320, height: 320 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
		assert.ok(pane.element.querySelectorAll(".ash-scm-graph-commit").length > initialRows);
		assert.equal(pane.element.querySelector('.ash-scm-graph-commit'), firstCommit, 'Growing the viewport keeps existing rows');
		assert.equal(firstCommit.querySelector('.ash-scm-graph-actions'), firstToolbar);
		assert.equal(browser.window.document.activeElement, firstCommit);
		hoverHandles.get(firstCommit)!.show();
		viewport.scrollTop = 264;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.ok(!firstCommit.isConnected, 'Leaving the overscan range removes the row');
		assert.ok(hiddenHoverTargets.has(firstCommit), 'Leaving the viewport hides the details card');
		assert.ok(!disposedHoverTargets.has(firstCommit), 'The bounded row cache retains the hover for reuse');
		const overlapping = [...pane.element.querySelectorAll<HTMLElement>('.ash-scm-graph-commit')].find(element => element.textContent?.includes('Commit 12'))!;
		overlapping.focus();
		viewport.scrollTop = 286;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.ok(overlapping.isConnected, 'An overlapping visible row remains connected');
		assert.equal(browser.window.document.activeElement, overlapping);

		const list = graph.querySelector<HTMLElement>('.ash-list');
		assert.ok(list);
		viewport.scrollTop = 1000;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.ok([...pane.element.querySelectorAll(".ash-scm-graph-subject")].some((element) => element.textContent === "Commit 45"));
		assert.ok(pane.element.querySelectorAll(".ash-scm-graph-commit").length < commits.length);
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.equal(pane.element.querySelector('.ash-scm-graph-commit'), firstCommit, 'Returning reuses the cached commit');
		pane.dispose();
		assert.equal(disposedHoverTargets.size, hoverTargets.length, 'Disposal releases visible and cached rows');
	} finally {
		Reflect.deleteProperty(globalThis, "ResizeObserver");
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("SCMHistoryViewPane expands commit files and opens a selected change in the diff editor", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const [{ ContextKeyService }, { MenuService }, { InstantiationService }, { CommandService }] = await Promise.all([
		import("../../../../../platform/contextkey/browser/contextKeyService.js"),
		import("../../../../../platform/actions/common/menuService.js"),
		import('../../../../../platform/instantiation/common/instantiationService.js'),
		import("../../../../../workbench/services/commands/common/commandService.js"),
	]);
	using contextKeyService = new ContextKeyService();
	const menuService = new MenuService(new CommandService(new InstantiationService()), contextKeyService);
	const objectId = "1".repeat(40);
	const parentObjectId = "2".repeat(40);
	let changeRequests = 0;
	let fileRequests = 0;
	const gitService = {
		onDidBecomeReady: noEvent,
		onDidChangeActiveRepository: noEvent,
		status: async (): Promise<GitStatus> => ({
			repositoryId: "repo-1",
			streamInstanceId: "git-graph-stream",
			revision: 1,
			workspacePath: ".",
			head: { type: "branch", name: "main", objectId, upstream: undefined },
			changes: [],
		}),
		branches: async () => [],
		graph: async () => ({
			commits: [{ objectId, parentObjectIds: [parentObjectId], timestampSeconds: 1_753_000_000, subject: "Change editor files" }],
			references: [{ name: "main", objectId, kind: "localBranch" as const, remoteName: undefined, current: true }],
			remotes: [],
			hasMore: false,
			nextCursor: undefined,
		}),
		commitChanges: async () => {
			changeRequests += 1;
			return { parentObjectId, changes: [{ path: "src/editor.ts", originalPath: undefined, status: "modified" as const }] };
		},
		commitFile: async () => {
			fileRequests += 1;
			return { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "text" as const, text: "after\n" } };
		},
	} as unknown as IGitService;
	const opened: Array<{ readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target?: EditorOpenTarget; }> = [];
	const editorService = testEditorService(opened);
	const hoverService: IHoverService = {
		setupDelayedHover: () => testManagedHover(),
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() { },
	};
	const contextMenus: Array<{
		readonly menuId: MenuId;
		readonly menuActionOptions?: { readonly arg?: unknown; readonly args?: readonly unknown[]; };
	}> = [];
	const contextMenuService = {
		showContextMenu: (options: { readonly menuId: MenuId; readonly menuActionOptions?: { readonly arg?: unknown; readonly args?: readonly unknown[]; }; }) => contextMenus.push(options),
	} as unknown as IContextMenuService;

	try {
		using history = createHistoryViewFixture(gitService);
		const { SCMHistoryViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js");
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.changes.test", title: "Graph" }, history.viewService, menuService, contextMenuService, contextKeyService, hoverService, editorService, testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } });
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector(".ash-scm-graph-commit") !== null);

		const commit = pane.element.querySelector<HTMLElement>(".ash-scm-graph-commit");
		assert.ok(commit);
		commit.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus[0]?.menuId, MenuId.SCMHistoryItemContext);
		assert.equal((contextMenus[0]?.menuActionOptions?.arg as { readonly historyItemViewModel: { readonly historyItem: { readonly id: string; }; }; }).historyItemViewModel.historyItem.id, objectId);
		commit.focus();
		commit.click();
		await waitFor(() => pane.element.querySelector(".ash-scm-graph-change") !== null);
		assert.equal(pane.element.querySelector('.ash-scm-graph-commit'), commit);
		assert.equal(browser.window.document.activeElement, commit);
		assert.equal(changeRequests, 1);
		assert.equal(fileRequests, 0);
		assert.equal(pane.element.querySelector(".ash-scm-graph-commit")?.getAttribute("aria-expanded"), "true");
		assert.equal(pane.element.querySelector(".ash-scm-graph-change-label .ash-icon-label-text")?.textContent, "editor.ts");
		assert.equal(pane.element.querySelector(".ash-icon-label-description")?.textContent, "src");
		assert.equal(pane.element.querySelector(".ash-scm-graph-change-label .ash-icon-label-icon")?.getAttribute("data-file-icon"), "editor.ts");
		assert.ok([...pane.element.querySelectorAll<SVGPathElement>(".ash-scm-graph-path")].some((path) => path.getAttribute("d")?.endsWith("V 44")));
		assert.equal(commit.style.getPropertyValue("--scm-graph-node-x"), "11px");
		assert.equal(commit.style.getPropertyValue("--scm-graph-content-x"), "22px");
		assert.ok(commit.querySelector(":scope > .ash-scm-graph-row > .ash-scm-graph-graph"));

		const change = pane.element.querySelector<HTMLButtonElement>(".ash-scm-graph-change");
		change?.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus[1]?.menuId, MenuId.SCMHistoryItemChangeContext);
		assert.deepEqual(contextMenus[1]?.menuActionOptions?.arg && {
			itemId: (contextMenus[1].menuActionOptions.arg as { readonly historyItemViewModel: { readonly historyItem: { readonly id: string; }; }; }).historyItemViewModel.historyItem.id,
			path: (contextMenus[1].menuActionOptions.arg as { readonly historyItemChange: { readonly path: string; }; }).historyItemChange.path,
		}, { itemId: objectId, path: 'src/editor.ts' });
		change?.click();
		await waitFor(() => opened.length === 1);
		assert.equal(fileRequests, 1);
		assert.equal(opened[0].input.contentType, "application/vnd.stanza.editor-diff");
		assert.equal(opened[0].input.label, "editor.ts (2222222) ↔ editor.ts (1111111)");
		assert.equal(opened[0].options?.pinned, false);

		change?.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
		await waitFor(() => opened.length === 2);
		assert.equal(fileRequests, 2);
		assert.equal(opened[1].options?.pinned, true);
		change?.dispatchEvent(new browser.window.KeyboardEvent("keydown", { bubbles: true, key: " " }));
		await waitFor(() => opened.length === 3);
		assert.deepEqual(opened[2].options, { pinned: false, preserveFocus: true });
		change?.dispatchEvent(new browser.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter", altKey: true }));
		assert.equal(opened.length, 3);
		change?.focus();
		commit.click();
		assert.equal(commit.getAttribute('aria-expanded'), 'false');
		assert.equal(browser.window.document.activeElement, commit, 'Collapsing a focused child returns focus to its commit');
		assert.ok(!change?.isConnected);
		change?.click();
		assert.equal(opened.length, 3, 'Collapsing files disposes their action listeners');
		pane.dispose();
		change?.click();
		assert.equal(opened.length, 3);
		commit.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		change?.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus.length, 2);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test('SCM history opens a commit multi-diff from its inline action and context menu', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	using services = new InstantiationService();
	using contextKeys = new (await import('../../../../../platform/contextkey/browser/contextKeyService.js')).ContextKeyService();
	using notifications = new NotificationService();
	const { MenuService } = await import('../../../../../platform/actions/common/menuService.js');
	const commands = new CommandService(services);
	const menus = new MenuService(commands, contextKeys);
	const objectId = '1'.repeat(40);
	const parentId = '2'.repeat(40);
	const opened: Array<{ readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target?: EditorOpenTarget; }> = [];
	services.registerInstance(IEditorService, testEditorService(opened));
	services.registerInstance(INotificationService, notifications);
	const requests: Array<{ readonly id: string; readonly path?: string; readonly repository?: string; }> = [];
	const changes = [
		{ path: 'modified.ts', status: 'modified', originalPath: undefined },
		{ path: 'added.ts', status: 'added', originalPath: undefined },
		{ path: 'deleted.ts', status: 'deleted', originalPath: undefined },
		{ path: 'renamed.ts', status: 'renamed', originalPath: 'old.ts' },
		{ path: 'image.png', status: 'modified', originalPath: undefined },
	];
	const git = {
		status: async () => ({ repositoryId: 'repo-1', head: { type: 'branch', name: 'main', objectId } }),
		branches: async () => [],
		graph: async () => ({ commits: [{ objectId, parentObjectIds: [parentId, '3'.repeat(40)], subject: 'Review commit', timestampSeconds: 1 }], references: [], remotes: [], hasMore: false }),
		commitChanges: async (id: string, repository?: string) => {
			requests.push({ id, repository });
			return { parentObjectId: parentId, changes };
		},
		commitFile: async (id: string, path: string, repository?: string) => {
			requests.push({ id, path, repository });
			return {
				original: path === 'added.ts' ? { kind: 'missing' } : path === 'image.png' ? { kind: 'binary' } : { kind: 'text', text: 'before\n' },
				modified: path === 'deleted.ts' ? { kind: 'missing' } : path === 'image.png' ? { kind: 'binary' } : { kind: 'text', text: 'after\n' },
			};
		},
	} as unknown as IGitService;
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using history = createHistoryViewFixture(git);
		const { SCMHistoryViewPane } = await import('../../browser/scmHistoryViewPane.js');
		const hover: IHoverService = { setupDelayedHover: () => testManagedHover(), setupHover: () => testManagedHover(), showHover: () => testManagedHover(), hideHover() { } };
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: 'history-multidiff', title: 'Graph' }, history.viewService, menus, testContextMenuProvider as IContextMenuService, contextKeys, hover, testEditorService(opened), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } });
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector('.ash-scm-graph-actions button') !== null);
		const commit = pane.element.querySelector<HTMLElement>('.ash-scm-graph-commit')!;
		const button = commit.querySelector<HTMLButtonElement>('[data-action-id="workbench.scm.action.graph.viewChanges"] > button')!;
		assert.equal(button.getAttribute('aria-label'), 'Open Changes');
		assert.match(pane.element.querySelector('[role="tree"]')!.getAttribute('aria-description')!, /比较该提交的所有文本文件/);
		button.click();
		await waitFor(() => opened.length === 1);
		assert.equal(commit.getAttribute('aria-expanded'), 'false', 'Opening the multi-diff does not expand the commit');
		const input = opened[0].input;
		assert.ok(isMultiDiffEditorInput(input));
		const serialized = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
		assert.deepEqual(EditorInputSerializers.serialize(EditorInputSerializers.deserialize(serialized)), serialized);
		assert.deepEqual(input.items.map(item => ({ label: item.label, before: item.original.initialText, after: item.modified.initialText, readOnly: [item.original.readOnly, item.modified.readOnly] })), [
			{ label: 'modified.ts', before: 'before\n', after: 'after\n', readOnly: [true, true] },
			{ label: 'added.ts', before: '', after: 'after\n', readOnly: [true, true] },
			{ label: 'deleted.ts', before: 'before\n', after: '', readOnly: [true, true] },
			{ label: 'old.ts → renamed.ts', before: 'before\n', after: 'after\n', readOnly: [true, true] },
		]);
		assert.ok(input.items[3].original.resource.path.endsWith('/old.ts'));
		assert.ok(input.items[0].original.resource.path.includes(parentId));
		assert.deepEqual(opened[0].options, { pinned: true });
		assert.equal(notifications.getNotifications()[0].message, '1 个二进制文件无法在文本比较中显示。');
		assert.equal(requests.length, 6);
		assert.ok(requests.every(request => request.id === objectId && request.repository === 'repo-1'));
		const historyItem = (await history.viewService.activeRepository!.provider.historyProvider!.provideHistoryItems({ limit: 1 }))![0];
		const context = { repository: history.viewService.activeRepository!, historyItemViewModel: { historyItem }, type: 'historyItemViewModel' };
		const action = menus.getMenuActions(MenuId.SCMHistoryItemContext, { arg: context }).flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.viewChanges')!;
		await action.run();
		assert.equal(opened.length, 2);
		assert.equal(opened[1].input.resource.toString(), input.resource.toString());
		pane.dispose();
		button.click();
		assert.equal(opened.length, 2);
	} finally {
		resetNlsResolver();
		browser.window.close();
		for (const name of installedGlobals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test("ScmAgentReviewViewPane exposes an explicit empty state", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);

	try {
		const { ScmAgentReviewViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmAgentReviewViewPane.js");
		using pane = new ScmAgentReviewViewPane(browser.window.document.body, { id: "ash.gitAgentReview.test", title: "Agent Review" });
		assert.equal(pane.element.querySelector(".ash-scm-empty")?.textContent, "No agent changes to review.");
		const findIssues = pane.element.querySelector<HTMLButtonElement>(".ash-scm-find-issues");
		assert.ok(findIssues);
		assert.equal(findIssues.textContent, "Find Issues");
		assert.ok(findIssues.classList.contains("ash-button"));
		assert.ok(findIssues.classList.contains("label-centered"));
		assert.ok(findIssues.querySelector(".ash-icon"));
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test('Changes title actions execute on their captured repository and retain view and sort choices', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	try {
		await import('../../../git/browser/git.contribution.js');
		await import('../../browser/scm.contribution.js');
		const { ScmViewPane } = await import('../../browser/scmViewPane.js');
		using resources = new DisposableStore();
		using dependencies = createTestEditorServices(undefined, undefined, browser.window.document);
		using services = dependencies.createChild();
		using scm = new SCMService();
		using views = new SCMViewService(scm);
		const calls: string[] = [];
		const repositories = ['first', 'second'].map(id => ({ id, label: id, path: `/${id}`, root: URI.file(`/${id}`) }));
		const snapshots = new Map(repositories.map(repository => [repository.id, {
			repositoryId: repository.id, streamInstanceId: 'stream', revision: 1, workspacePath: repository.path,
			head: { type: 'branch' as const, name: 'main', objectId: '1234567', upstream: undefined },
			changes: [change('a/z.ts', 'unmodified', 'modified'), change('b/a.ts', 'unmodified', 'added')],
		} satisfies GitStatus]));
		const staging = new DeferredPromise<GitStatus>();
		const git = {
			onDidChangeRepositoryStatus: Event.None, onDidBecomeReady: Event.None,
			status: async (id: string) => snapshots.get(id)!,
			stage: async (_paths: readonly string[], id: string) => { calls.push(id); return staging.p; },
		} as unknown as IGitService;
		for (const repository of repositories) {
			const provider = resources.add(new GitSCMProvider(git, repository, {} as GitHistoryProvider, testGitProviderServices()));
			resources.add(scm.registerSCMProvider(provider));
		}
		services.registerInstance(ISCMService, scm);
		services.registerInstance(ISCMViewService, views);
		services.registerInstance(IContextMenuService, testContextMenuProvider);
		using commands = new CommandService(services);
		services.registerInstance(ICommandService, commands);
		const { registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
		const menus = new MenuService(commands, services.get(IContextKeyService));
		services.registerInstance(IMenuService, menus);
		registerCodeEditorServices(services);
		using pane = services.createInstance(ScmViewPane, browser.window.document.body, { id: VIEW_PANE_ID, title: 'Changes' });
		services.registerInstance(IViewsService, { getViewWithId: () => pane } as unknown as IViewsService);
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelectorAll('.ash-scm-change').length === 2);
		const context = services.get(IContextKeyService).getContext(pane.element);
		assert.equal(context.getValue('scmViewMode'), 'tree');
		using scoped = services.get(IContextKeyService).createScoped(pane.element.querySelector<HTMLElement>('.ash-scm')!);
		const captured = menus.getMenuActions(MenuId.for('git.changes'), { arg: 'first' }, scoped);
		const stage = captured.flatMap(([, actions]) => actions).find(action => action.id === 'git.stageAll')!;
		views.selectRepository('second');
		const operation = stage.run();
		assert.deepEqual(calls, ['first']);
		assert.equal(scm.getRepository('first')!.provider.isBusy, true);
		views.selectRepository('first');
		assert.equal(pane.element.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.disabled, true);
		await staging.complete({ ...snapshots.get('first')!, revision: 2, changes: [] });
		await operation;
		assert.equal(scm.getRepository('first')!.provider.isBusy, false);
		views.selectRepository('second');
		await commands.executeCommand('workbench.scm.action.setListViewMode');
		assert.equal(pane.element.querySelectorAll('.ash-scm-folder').length, 0);
		await commands.executeCommand('workbench.scm.action.setSortKey.name');
		assert.deepEqual([...pane.element.querySelectorAll('.ash-scm-change-open')].map(element => element.getAttribute('aria-label')), ['Open changes for b/a.ts', 'Open changes for a/z.ts']);
		assert.equal(dependencies.get(IStorageService).get('scm.viewMode', StorageScope.WORKSPACE), 'list');
		assert.equal(dependencies.get(IStorageService).get('scm.viewSortKey', StorageScope.WORKSPACE), 'name');
	} finally {
		browser.window.close();
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
	}
});

type ResourceGroupMenuFixture = DisposableStore & {
	readonly services: InstantiationService;
	readonly scm: SCMService;
	readonly openedViews: readonly string[];
	readonly viewHost: { getViewWithId: () => ScmViewPane; openView: (id: string) => Promise<ScmViewPane | undefined>; };
	readonly browser: JSDOM;
	readonly pane: ScmViewPane;
	readonly tree: HTMLElement;
	readonly views: SCMViewService;
	readonly menus: MenuService;
	readonly commands: CommandService;
	readonly group: (label: string) => HTMLElement;
	readonly folder: (label: string, groupLabel?: string) => HTMLElement;
	readonly key: (value: string, shiftKey?: boolean) => void;
	readonly lastMenu: () => IContextMenuDelegate;
	readonly menuCount: () => number;
	readonly hideMenu: () => void;
	readonly layoutMenu: () => void;
	readonly refresh: () => void;
	readonly removeGroup: (label: string) => void;
};

async function createResourceGroupMenuFixture(renderContextMenu = false, groupLabels: readonly string[] = ['Staged Changes', 'Changes']): Promise<ResourceGroupMenuFixture> {
	const resources = new DisposableStore();
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	const disposeDom = (): void => {
		browser.window.close();
		for (const name of globals) {
			Reflect.deleteProperty(globalThis, name);
		}
	};
	resources.add(toDisposable(disposeDom));
	try {
		await import('../../browser/scm.contribution.js');
		const { ScmViewPane } = await import('../../browser/scmViewPane.js');
		const dependencies = resources.add(createTestEditorServices(undefined, undefined, browser.window.document));
		const services = resources.add(dependencies.createChild());
		services.registerInstance(ILayoutService, { mainContainer: browser.window.document.body } as unknown as ILayoutService);
		const scm = resources.add(new SCMService());
		const views = resources.add(new SCMViewService(scm));
		const changes = resources.add(new Emitter<void>());
		const resource = (path: string) => ({
			sourceUri: URI.file(`/workspace/${path}`), path,
			decorations: { badge: 'M', tooltip: 'Modified', kind: 'modified' },
			openLabel: `Open ${path}`, actions: [], open: async () => { },
		});
		let groups: readonly ISCMResourceGroup[] = groupLabels.map((label, index) => ({
			id: String(index), label,
			resources: [resource('root.ts'), resource('src/one.ts'), resource('src/nested/two.ts'), resource('other/three.ts')],
			actions: [],
		}));
		resources.add(scm.registerSCMProvider({
			...testSCMProvider('first', 'first'), rootUri: URI.file('/workspace'),
			get groups() { return groups; }, onDidChangeResources: changes.event,
		}));
		resources.add(scm.registerSCMProvider({
			...testSCMProvider('second', 'second'), rootUri: URI.file('/workspace'),
			// Reusing a group object must not let a captured menu retarget another repository.
			groups,
		}));
		services.registerInstance(ISCMService, scm);
		services.registerInstance(ISCMViewService, views);
		const commands = resources.add(new CommandService(services));
		services.registerInstance(ICommandService, commands);
		const contextKeys = services.get(IContextKeyService);
		const menus = new MenuService(commands, contextKeys);
		services.registerInstance(IMenuService, menus);
		let menu: IContextMenuDelegate | undefined;
		let menuCount = 0;
		let contextView: BrowserContextViewService | undefined;
		let contextMenu: BrowserContextMenuService | undefined;
		if (renderContextMenu) {
			// jsdom has no geometry; focus and menu events still use the production owners.
			Object.defineProperties(browser.window.Element.prototype, {
				getClientRects: { configurable: true, value: () => [{}] },
				scrollTo: { configurable: true, value(): void { } },
			});
			contextView = resources.add(new BrowserContextViewService(browser.window.document.body));
			services.registerInstance(IContextViewService, contextView);
		}
		services.registerInstance(IContextMenuService, {
			onDidShowContextMenu: contextMenu?.onDidShowContextMenu ?? Event.None,
			onDidHideContextMenu: contextMenu?.onDidHideContextMenu ?? Event.None,
			showContextMenu: delegate => {
				menu = transformContextMenuDelegate(delegate, menus, contextKeys);
				menuCount++;
				contextMenu?.showContextMenu(delegate);
			},
			hideContextMenu: () => {
				if (contextMenu) contextMenu.hideContextMenu();
				else menu?.onHide?.(true);
			},
		});
		const { registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
		registerCodeEditorServices(services);
		if (renderContextMenu) contextMenu = resources.add(services.createInstance(BrowserContextMenuService));
		const pane = resources.add(services.createInstance(ScmViewPane, browser.window.document.body, { id: VIEW_PANE_ID, title: 'Changes' }));
		const openedViews: string[] = [];
		const viewHost: ResourceGroupMenuFixture['viewHost'] = {
			getViewWithId: () => pane,
			openView: async (id: string) => { openedViews.push(id); pane.setVisible(true); return pane; },
		};
		services.registerInstance(IViewsService, viewHost as unknown as IViewsService);
		browser.window.document.body.append(pane.element);
		pane.setVisible(true);
		const tree = pane.element.querySelector<HTMLElement>('[role="tree"]')!;
		const group = (label: string): HTMLElement => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]')].find(row => row.querySelector('.ash-scm-section-label')?.textContent === label)!;
		const folder = (label: string, groupLabel = 'Changes'): HTMLElement => {
			const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
			const following = rows.slice(rows.indexOf(group(groupLabel)) + 1);
			const end = following.findIndex(row => row.getAttribute('aria-level') === '1');
			return following.slice(0, end < 0 ? following.length : end).find(row => row.querySelector('.ash-scm-folder .ash-icon-label-text')?.textContent === label)!;
		};
		return Object.assign(resources, {
			browser, pane, tree, views, menus, commands, group, folder, services, scm, openedViews, viewHost,
			key: (value: string, shiftKey = false) => { tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })); },
			lastMenu: (): IContextMenuDelegate => { assert.ok(menu, 'The real group input must open a context menu'); return menu; },
			menuCount: () => menuCount,
			hideMenu: () => services.get(IContextMenuService).hideContextMenu(),
			layoutMenu: () => contextView?.layout(),
			refresh: () => { groups = groups.map(group => ({ ...group, resources: [...group.resources, resource('src/added.ts')] })); changes.fire(); },
			removeGroup: (label: string) => { groups = groups.filter(group => group.label !== label); changes.fire(); },
		});
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

for (const mode of ['tree', 'list'] as const) {
	test(`SCM resource group navigation cycles through rendered groups in ${mode} mode without expanding them`, async () => {
		using fixture = await createResourceGroupMenuFixture(false, ['Merge Changes', 'Staged Changes', 'Changes']);
		const { tree, group, commands, key } = fixture;
		fixture.pane.viewMode = mode;
		tree.focus();
		key('Home');
		key('ArrowLeft');
		const first = group('Merge Changes');
		const expansion = first.getAttribute('aria-expanded');
		for (const [command, label] of [
			['focusPreviousResourceGroup', 'Changes'],
			['focusNextResourceGroup', 'Merge Changes'],
			['focusNextResourceGroup', 'Staged Changes'],
			['focusNextResourceGroup', 'Changes'],
			['focusNextResourceGroup', 'Merge Changes'],
		]) {
			await commands.executeCommand(`workbench.scm.action.${command}`);
			assert.equal(tree.getAttribute('aria-activedescendant'), group(label!).id);
			assert.deepEqual([...tree.querySelectorAll('[aria-selected="true"]')].map(row => row.id), [group(label!).id]);
			assert.equal(fixture.browser.window.document.activeElement, tree);
			assert.equal(first.getAttribute('aria-expanded'), expansion);
		}
		assert.deepEqual(fixture.openedViews, Array(5).fill(VIEW_PANE_ID));
		for (const id of ['workbench.scm.action.focusPreviousResourceGroup', 'workbench.scm.action.focusNextResourceGroup']) {
			assert.ok(CommandsRegistry.hasCommand(id));
			assert.equal(KeybindingsRegistry.getKeybindings().some(rule => 'command' in rule && rule.command === id), false);
			assert.equal(fixture.menus.getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).some(action => action.id === id), false);
		}
	});
}

test('SCM resource group navigation starts at the first group from a file, folder or outside tree focus', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { tree, commands, key, group } = fixture;
	for (const direction of ['focusPreviousResourceGroup', 'focusNextResourceGroup']) {
		for (const steps of [1, 2, 3]) {
			tree.focus();
			key('Home');
			for (let index = 0; index < steps; index++) key('ArrowDown');
			await commands.executeCommand(`workbench.scm.action.${direction}`);
			assert.equal(tree.getAttribute('aria-activedescendant'), group('Staged Changes').id);
		}
		await commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
		const input = fixture.browser.window.document.createElement('input');
		fixture.browser.window.document.body.append(input);
		input.focus();
		await commands.executeCommand(`workbench.scm.action.${direction}`);
		assert.equal(tree.getAttribute('aria-activedescendant'), group('Staged Changes').id);
		input.remove();
	}
});

test('SCM resource group navigation handles zero and one group without changing a focused single group', async () => {
	using fixture = await createResourceGroupMenuFixture(false, ['Changes']);
	const { tree, commands, key, group } = fixture;
	await commands.executeCommand('workbench.scm.action.focusPreviousResourceGroup');
	assert.equal(tree.getAttribute('aria-activedescendant'), group('Changes').id);
	key('ArrowLeft');
	const before = tree.outerHTML;
	await commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
	assert.equal(tree.outerHTML, before);
	fixture.removeGroup('Changes');
	await commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
	await commands.executeCommand('workbench.scm.action.focusPreviousResourceGroup');
	assert.equal(tree.querySelectorAll('[role="treeitem"]').length, 0);
});

test('SCM resource group navigation follows replacement snapshots and the repository selected while the view opens', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { commands, tree, group } = fixture;
	await commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
	fixture.refresh();
	await commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
	assert.equal(tree.getAttribute('aria-activedescendant'), group('Changes').id);
	fixture.removeGroup('Changes');
	await commands.executeCommand('workbench.scm.action.focusPreviousResourceGroup');
	assert.equal(tree.getAttribute('aria-activedescendant'), group('Staged Changes').id);
	const opening = new DeferredPromise<ScmViewPane>();
	fixture.viewHost.openView = () => opening.p;
	const outside = fixture.browser.window.document.createElement('input');
	fixture.browser.window.document.body.append(outside);
	outside.focus();
	const operation = commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
	fixture.views.selectRepository('second');
	await opening.complete(fixture.pane);
	await operation;
	assert.equal(tree.getAttribute('aria-activedescendant'), group('Staged Changes').id);
	assert.deepEqual(JSON.parse(group('Staged Changes').getAttribute('data-tree-id')!), ['second', '0']);
});

test('SCM resource group navigation ignores unavailable views and disposed panes', async () => {
	using fixture = await createResourceGroupMenuFixture();
	fixture.viewHost.openView = async () => undefined;
	await fixture.commands.executeCommand('workbench.scm.action.focusNextResourceGroup');
	fixture.viewHost.openView = async () => fixture.pane;
	fixture.pane.dispose();
	const outside = fixture.browser.window.document.createElement('input');
	fixture.browser.window.document.body.append(outside);
	outside.focus();
	await fixture.commands.executeCommand('workbench.scm.action.focusPreviousResourceGroup');
	assert.equal(fixture.browser.window.document.activeElement, outside);
});

test('SCM resource group navigation help reuses tree instructions and restores only a visible owned focus target', async () => {
	using fixture = await createResourceGroupMenuFixture(true);
	const help = AccessibleViewRegistry.getImplementations().find(implementation => implementation.name === 'scm' && implementation.type === AccessibleViewType.Help)!;
	fixture.tree.focus();
	const provider = help.getProvider(fixture.services)!;
	assert.match(provider.provideContent(), /<keybinding:workbench.scm.action.focusPreviousResourceGroup>/);
	assert.match(provider.provideContent(), /<keybinding:workbench.scm.action.focusNextResourceGroup>/);
	fixture.browser.window.document.body.focus();
	provider.dispose();
	assert.equal(fixture.browser.window.document.activeElement, fixture.tree);
	const hidden = help.getProvider(fixture.services)!;
	fixture.pane.setVisible(false);
	const outside = fixture.browser.window.document.createElement('input');
	fixture.browser.window.document.body.append(outside);
	outside.focus();
	hidden.dispose();
	hidden.dispose();
	assert.equal(fixture.browser.window.document.activeElement, outside);
	assert.equal(help.getProvider(fixture.services), undefined);
	fixture.pane.setVisible(true);
	fixture.tree.focus();
	const removed = help.getProvider(fixture.services)!;
	fixture.pane.dispose();
	outside.focus();
	removed.dispose();
	assert.equal(fixture.browser.window.document.activeElement, outside);
});

test('SCM resource group navigation help preserves welcome content and Chinese instructions', async () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using fixture = await createResourceGroupMenuFixture(true);
		const help = AccessibleViewRegistry.getImplementations().find(implementation => implementation.name === 'scm' && implementation.type === AccessibleViewType.Help)!;
		fixture.tree.focus();
		using provider = help.getProvider(fixture.services)!;
		assert.match(provider.provideContent(), /上一个资源分组/);
		assert.match(provider.provideContent(), /<keybinding:workbench.scm.action.focusNextResourceGroup>/);
		fixture.scm.getRepository('first')!.dispose();
		fixture.scm.getRepository('second')!.dispose();
		using welcome = help.getProvider(fixture.services)!;
		assert.match(welcome.provideContent(), /源代码管理尚无仓库/);
		assert.doesNotMatch(welcome.provideContent(), /focusNextResourceGroup/);
	} finally {
		resetNlsResolver();
	}
});

test('SCM group right-click collapses only its directories recursively and retains tree state on refresh', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { browser, tree, group, folder, key } = fixture;
	tree.focus();
	key('Home');
	const focus = tree.getAttribute('aria-activedescendant');
	const selection = [...tree.querySelectorAll('[aria-selected="true"]')].map(row => row.id);
	group('Changes').querySelector('.ash-scm-section-label')!.dispatchEvent(new browser.window.MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }));
	const action = fixture.lastMenu().getActions().find(action => action.id === 'workbench.scm.action.collapseAll');
	assert.ok(action, 'The group context menu must contribute Collapse All');
	await action.run();
	assert.equal(group('Changes').getAttribute('aria-expanded'), 'true');
	assert.equal(folder('src').getAttribute('aria-expanded'), 'false');
	assert.equal(folder('other').getAttribute('aria-expanded'), 'false');
	assert.equal(folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'true');
	assert.equal(tree.querySelectorAll('[aria-label="Open root.ts"]').length, 2);
	assert.equal(tree.getAttribute('aria-activedescendant'), focus);
	assert.deepEqual([...tree.querySelectorAll('[aria-selected="true"]')].map(row => row.id), selection);
	assert.equal(browser.window.document.activeElement, tree);
	fixture.refresh();
	assert.equal(folder('src').getAttribute('aria-expanded'), 'false');
	folder('src').querySelector<HTMLElement>('.ash-scm-folder')!.click();
	assert.equal(folder('nested').getAttribute('aria-expanded'), 'false', 'Reopening a parent must leave its descendants folded');
	assert.equal(tree.querySelectorAll('[aria-label="Open src/added.ts"]').length, 2);
});

test('SCM group keyboard menu uses the focused group and Escape retains its expansion', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { browser, tree, group, folder, key } = fixture;
	tree.focus();
	key('Home');
	key('F10', true);
	assert.equal(fixture.lastMenu().getActions().filter(action => action.id === 'workbench.scm.action.collapseAll').length, 1);
	fixture.lastMenu().onHide?.(true);
	assert.equal(browser.window.document.activeElement, tree);
	assert.equal(group('Staged Changes').getAttribute('aria-expanded'), 'true');
	assert.equal(folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'true');
	key('F10', true);
	await fixture.lastMenu().getActions().find(action => action.id === 'workbench.scm.action.collapseAll')!.run();
	assert.equal(group('Staged Changes').getAttribute('aria-expanded'), 'true');
	assert.equal(folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'false');
	assert.equal(folder('src').getAttribute('aria-expanded'), 'true');
	assert.equal(browser.window.document.activeElement, tree);
});

test('SCM group ContextMenu preserves the macOS host path and opens the group on other platforms', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { browser, tree, key } = fixture;
	tree.focus();
	key('Home');
	const focus = tree.getAttribute('aria-activedescendant');
	let hostEvent: KeyboardEvent | undefined;
	const hostListener = (event: KeyboardEvent): void => { hostEvent = event; };
	browser.window.document.body.addEventListener('keydown', hostListener);
	fixture.add(toDisposable(() => browser.window.document.body.removeEventListener('keydown', hostListener)));
	const event = new browser.window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true });
	tree.dispatchEvent(event);
	assert.equal(fixture.menuCount(), isMacintosh ? 0 : 1);
	assert.equal(event.defaultPrevented, !isMacintosh);
	assert.equal(hostEvent, isMacintosh ? event : undefined);
	assert.equal(tree.getAttribute('aria-activedescendant'), focus);
	assert.equal(fixture.folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'true');
	assert.equal(browser.window.document.activeElement, tree);
});

test('SCM group menus reject captured contexts after a repository switch, snapshot replacement or disposal', async () => {
	using fixture = await createResourceGroupMenuFixture();
	fixture.tree.focus();
	fixture.key('Home');
	fixture.key('F10', true);
	const action = fixture.lastMenu().getActions().find(action => action.id === 'workbench.scm.action.collapseAll')!;
	fixture.views.selectRepository('second');
	const newFocus = fixture.tree.querySelector<HTMLButtonElement>('[aria-label="Open root.ts"]')!;
	newFocus.focus();
	fixture.lastMenu().onHide?.(true);
	await action.run();
	assert.equal(fixture.folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'true', 'A same-named group in another repository must remain open');
	assert.equal(fixture.browser.window.document.activeElement, newFocus, 'The old menu must not steal focus in the new repository');
	fixture.views.selectRepository('first');
	const replacedHeading = fixture.group('Staged Changes').querySelector('.ash-scm-section-label')!;
	const beforeRefreshMenuCount = fixture.menuCount();
	fixture.refresh();
	await action.run();
	assert.equal(fixture.folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'true', 'A replaced snapshot must invalidate the old group object');
	replacedHeading.dispatchEvent(new fixture.browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	assert.equal(fixture.menuCount(), beforeRefreshMenuCount, 'Replaced rows must release their context-menu listeners');
	fixture.key('Home');
	fixture.key('F10', true);
	const removedGroupAction = fixture.lastMenu().getActions().find(action => action.id === 'workbench.scm.action.collapseAll')!;
	fixture.removeGroup('Staged Changes');
	await removedGroupAction.run();
	assert.equal(fixture.folder('src').getAttribute('aria-expanded'), 'true');
	fixture.key('Home');
	fixture.key('F10', true);
	const disposedAction = fixture.lastMenu().getActions().find(action => action.id === 'workbench.scm.action.collapseAll')!;
	const menuCount = fixture.menuCount();
	const retainedHeading = fixture.group('Changes').querySelector('.ash-scm-section-label')!;
	fixture.pane.dispose();
	await disposedAction.run();
	retainedHeading.dispatchEvent(new fixture.browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	assert.equal(fixture.menuCount(), menuCount, 'Released rows must not open further menus');
});

test('SCM group Collapse All is limited to tree group menus and excluded from the title and F1', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const id = 'workbench.scm.action.collapseAll';
	assert.equal(fixture.menus.getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).some(action => action.id === id), false);
	assert.equal(fixture.menus.getMenuActions(MenuId.SCMTitle).flatMap(([, actions]) => actions).some(action => action.id === id), false);
	fixture.pane.viewMode = 'list';
	fixture.group('Changes').querySelector('.ash-scm-section-label')!.dispatchEvent(new fixture.browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	fixture.tree.focus();
	fixture.key('Home');
	fixture.key('F10', true);
	assert.equal(fixture.menuCount(), 0);
	fixture.pane.viewMode = 'tree';
	fixture.key('Home');
	fixture.key('ArrowDown');
	fixture.key('F10', true);
	assert.equal(fixture.menuCount(), 0, 'Directory focus is not a group context');
	assert.equal(fixture.folder('src').getAttribute('aria-expanded'), 'true');
});

test('SCM group menu closure preserves focus transferred outside the pane in the same repository', async () => {
	using fixture = await createResourceGroupMenuFixture(true);
	const { browser, tree, key } = fixture;
	const outside = browser.window.document.createElement('input');
	browser.window.document.body.append(outside);
	tree.focus();
	key('Home');
	key('F10', true);
	assert.equal(browser.window.document.activeElement?.getAttribute('role'), 'menu');
	outside.focus();
	fixture.hideMenu();
	assert.equal(browser.window.document.activeElement, outside);
	assert.equal(browser.window.document.querySelector('[role="menu"]'), null);
});

test('SCM group menu closure does not focus a hidden pane', async () => {
	using fixture = await createResourceGroupMenuFixture(true);
	const { browser, pane, tree, key } = fixture;
	const outside = browser.window.document.createElement('input');
	browser.window.document.body.append(outside);
	tree.focus();
	key('Home');
	key('F10', true);
	pane.setVisible(false);
	outside.focus();
	fixture.hideMenu();
	assert.equal(browser.window.document.activeElement, outside);
	assert.equal(pane.isBodyVisible(), false);
});

test('SCM group menu closure after a snapshot removes its anchor does not steal outside focus', async () => {
	using fixture = await createResourceGroupMenuFixture(true);
	const { browser, tree, key } = fixture;
	const outside = browser.window.document.createElement('input');
	browser.window.document.body.append(outside);
	tree.focus();
	key('Home');
	key('F10', true);
	const anchor = browser.window.document.getElementById(tree.getAttribute('aria-activedescendant')!)!;
	outside.focus();
	fixture.removeGroup('Staged Changes');
	assert.equal(anchor.isConnected, false);
	fixture.layoutMenu();
	assert.equal(browser.window.document.querySelector('[role="menu"]'), null);
	assert.equal(browser.window.document.activeElement, outside);
});

test('SCM group real menu returns focus on Escape and on action activation', async () => {
	using fixture = await createResourceGroupMenuFixture(true);
	const { browser, tree, key } = fixture;
	tree.focus();
	key('Home');
	key('F10', true);
	const menu = browser.window.document.querySelector<HTMLElement>('[role="menu"]')!;
	assert.equal(browser.window.document.activeElement, menu);
	menu.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(browser.window.document.activeElement, tree);
	assert.equal(fixture.folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'true');
	key('F10', true);
	browser.window.document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
	assert.equal(browser.window.document.activeElement, tree);
	assert.equal(fixture.folder('src', 'Staged Changes').getAttribute('aria-expanded'), 'false');
	assert.equal(fixture.folder('src').getAttribute('aria-expanded'), 'true');
});

test('SCM group keyboard menu matches upstream modifiers and leaves other function keys untouched', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { browser, tree, key } = fixture;
	tree.focus();
	key('Home');
	for (const modifiers of [{}, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
		const event = new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, ...modifiers, bubbles: true, cancelable: true });
		const menuCount = fixture.menuCount();
		tree.dispatchEvent(event);
		assert.equal(fixture.menuCount(), menuCount + 1);
		assert.equal(event.defaultPrevented, true);
		fixture.hideMenu();
	}
	for (const options of [{ key: 'F10' }, { key: 'F10', ctrlKey: true }, { key: 'F9', shiftKey: true }]) {
		const event = new browser.window.KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
		const menuCount = fixture.menuCount();
		tree.dispatchEvent(event);
		assert.equal(fixture.menuCount(), menuCount);
		assert.equal(event.defaultPrevented, false);
	}
});

test('ScmViewPane folds groups through the shared tree and keeps state when resources refresh', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	using changes = new Emitter<void>();
	using iconChanges = new Emitter<void>();
	let iconTheme = "first";
	let hasFileIcons = true;
	let hasFolderIcons = false;
	const icons: IResourceIconRenderer = {
		...testFileIconThemeService(),
		getFileIconTheme: () => ({ ...noFileIconTheme, hasFileIcons, hasFolderIcons }),
		onDidChangeResourceIcons: iconChanges.event,
		renderFileIcon: (_resource, container) => { container.dataset.fileIcon = iconTheme; },
	};
	const opened: Array<{ path: string; pinned: boolean; }> = [];
	const openIntents: Array<{ options: IEditorOptions; sideBySide: boolean; }> = [];
	let groupActions = 0;
	let fileActions = 0;
	const resource = (path: string) => ({
		sourceUri: URI.file(`/workspace/${path}`), path,
		decorations: { badge: 'M', tooltip: 'Modified', kind: 'modified' },
		openLabel: `Open ${path}`,
		actions: [{ id: 'stage', label: 'Stage', tooltip: 'Stage', enabled: true, run: () => { fileActions++; } }],
		open: async (options: IEditorOptions, sideBySide: boolean) => {
			opened.push({ path, pinned: options.pinned === true });
			openIntents.push({ options, sideBySide });
		},
	});
	const groupAction = { id: 'stageAll', label: 'Stage All', tooltip: 'Stage All', enabled: true, run: () => { groupActions++; } };
	let groups = [{ id: 'changes', label: 'Changes', resources: [resource('first.ts')], actions: [groupAction] }];
	const provider: ISCMProvider = {
		...testSCMProvider('repo-1', 'workspace'),
		rootUri: URI.file('/workspace'),
		get groups() { return groups; },
		onDidChangeResources: changes.event,
		refresh: async () => {
			groups = [{ ...groups[0], resources: [resource('first.ts'), resource('second.ts')] }];
			changes.fire();
		},
	};
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
	try {
		const { ScmViewPane } = await import('../../browser/scmViewPane.js');
		using dependencies = createTestEditorServices(undefined, undefined, browser.window.document);
		using services = dependencies.createChild();
		using configuration = new InMemoryConfigurationService();
		using scm = new SCMService();
		using views = new SCMViewService(scm);
		using repository = scm.registerSCMProvider(provider);
		services.registerInstance(ISCMService, scm);
		services.registerInstance(ISCMViewService, views);
		services.registerInstance(IResourceLabelService, testResourceLabelService(icons));
		services.registerInstance(IResourceIconRenderer, icons);
		services.registerInstance(IContextMenuService, testContextMenuProvider);
		services.registerInstance(IWorkspaceContextService, testWorkspaceContext());
		services.registerInstance(IConfigurationService, configuration);
		const { registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
		registerCodeEditorServices(services);
		using pane = services.createInstance(ScmViewPane, browser.window.document.body, { id: 'scm-folding', title: 'Changes' });
		assert.match(pane.element.querySelector('.ash-scm-input .stanza-editor-input')!.getAttribute('aria-label')!, /^提交信息/u);
		const tree = pane.element.querySelector<HTMLElement>('[role="tree"]')!;
		const group = (): HTMLElement => tree.querySelector<HTMLElement>('[role="treeitem"][aria-level="1"]')!;
		const key = (value: string): void => { tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: value, bubbles: true })); };
		assert.equal(tree.getAttribute('aria-label'), '源代码管理更改');
		assert.ok(tree.getAttribute('aria-description')?.includes('左方向键折叠分组或目录'));
		assert.ok(tree.getAttribute('aria-description')?.includes('侧边分组'));
		const retainedFile = tree.querySelector<HTMLButtonElement>('[aria-label="Open first.ts"]')!;
		assert.equal(retainedFile.querySelector<HTMLElement>('[data-file-icon]')?.dataset.fileIcon, 'first');
		iconTheme = 'second';
		iconChanges.fire();
		assert.equal(tree.querySelector('[aria-label="Open first.ts"]'), retainedFile, 'Icon theme changes update shared labels without rebuilding tree rows');
		assert.equal(retainedFile.querySelector<HTMLElement>('[data-file-icon]')?.dataset.fileIcon, 'second');
		const fileTwistie = retainedFile.closest('.ash-tree-row')!.querySelector('.ash-tree-twistie')!;
		assert.ok(fileTwistie.classList.contains('ash-tree-twistie-hidden'));
		hasFolderIcons = true;
		iconChanges.fire();
		assert.ok(fileTwistie.classList.contains('ash-tree-twistie-hidden'), 'Flat changes lists align file icons with arrows even when folder icons exist');
		hasFileIcons = false;
		iconChanges.fire();
		assert.ok(fileTwistie.classList.contains('ash-tree-twistie-with-icon-gap'));
		hasFileIcons = true;
		iconChanges.fire();
		assert.ok(fileTwistie.classList.contains('ash-tree-twistie-hidden'));
		assert.equal(tree.querySelector('[aria-label="Open first.ts"]'), retainedFile);
		await configuration.updateValue('workbench.tree.indent', 16);
		assert.equal(tree.style.getPropertyValue('--ash-tree-indent'), '16px');
		await configuration.updateValue('workbench.tree.renderIndentGuides', 'none');
		assert.ok(tree.classList.contains('ash-tree-indent-guides-none'));
		assert.equal(group().getAttribute('aria-expanded'), 'true');
		group().querySelector<HTMLElement>('.ash-scm-section-label')!.click();
		assert.equal(group().getAttribute('aria-expanded'), 'false');
		assert.equal(tree.querySelectorAll('.ash-scm-change').length, 0);
		await pane.refresh();
		assert.equal(group().getAttribute('aria-expanded'), 'false');
		assert.equal(group().querySelector('.ash-count-badge')?.textContent, '2');
		assert.equal(group().querySelector('.ash-count-badge')?.getAttribute('aria-label'), '2 个更改');
		key('ArrowRight');
		assert.equal(group().getAttribute('aria-expanded'), 'true');
		assert.equal(tree.querySelectorAll('.ash-scm-change').length, 2);
		const groupButton = group().querySelector<HTMLButtonElement>('[aria-label="Stage All"]')!;
		groupButton.click();
		await waitFor(() => groupActions === 1);
		assert.equal(group().getAttribute('aria-expanded'), 'true');
		assert.deepEqual(opened, []);
		key('ArrowLeft');
		assert.equal(group().getAttribute('aria-expanded'), 'false');
		key('Enter');
		assert.equal(group().getAttribute('aria-expanded'), 'true');
		key('ArrowRight');
		key('Enter');
		assert.deepEqual(opened, [{ path: 'first.ts', pinned: false }, { path: 'first.ts', pinned: true }]);
		assert.deepEqual(openIntents, [
			{ options: { pinned: false, preserveFocus: true }, sideBySide: false },
			{ options: { pinned: true, preserveFocus: false }, sideBySide: false },
		]);
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
		assert.deepEqual(openIntents.at(-1), { options: { pinned: true, preserveFocus: false }, sideBySide: true });
		const fileButton = tree.querySelector<HTMLButtonElement>('.ash-scm-change-actions [aria-label="Stage"]')!;
		fileButton.click();
		await waitFor(() => fileActions === 1);
		assert.equal(opened.length, 3);
		group().querySelector<HTMLElement>('.ash-tree-twistie')!.click();
		assert.equal(group().getAttribute('aria-expanded'), 'false');
		await pane.refresh();
		groupButton.click();
		assert.equal(groupActions, 1, 'Replaced rows release their action listeners');
		group().querySelector<HTMLElement>('.ash-tree-twistie')!.click();
		tree.querySelector<HTMLButtonElement>('[aria-label="Open second.ts"]')!.click();
		assert.deepEqual(opened.at(-1), { path: 'second.ts', pinned: false });
		assert.equal(browser.window.document.activeElement, tree);
		await pane.refresh();
		assert.equal(browser.window.document.activeElement, tree, 'Git row replacement retains preview focus');
		groups = [{ ...groups[0], resources: [resource('src/one.ts'), resource('src/nested/two.ts'), resource('third.ts')] }];
		changes.fire();
		const folder = (): HTMLElement => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(row => row.querySelector('.ash-scm-folder .ash-icon-label-text')?.textContent === 'src')!;
		assert.deepEqual([...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(row => [row.querySelector('.ash-icon-label-text, .ash-scm-section-label')?.textContent, row.getAttribute('aria-level')]), [
			['Changes', '1'], ['src', '2'], ['nested', '3'], ['two.ts', '4'], ['one.ts', '3'], ['third.ts', '2'],
		]);
		const opensBeforeFolder = opened.length;
		key('Home');
		assert.equal(group().getAttribute('aria-expanded'), 'true');
		key('ArrowDown');
		assert.equal(folder().getAttribute('aria-expanded'), 'true', 'Keyboard navigation does not toggle a directory');
		folder().querySelector<HTMLElement>('.ash-scm-folder')!.click();
		assert.equal(folder().getAttribute('aria-expanded'), 'false');
		groups = [{ ...groups[0], resources: [...groups[0].resources, resource('src/three.ts')] }];
		changes.fire();
		assert.equal(folder().getAttribute('aria-expanded'), 'false', 'Directory identity retains folding across provider snapshots');
		assert.equal(tree.querySelector('[aria-label="Open src/one.ts"]'), null);
		key('ArrowRight');
		assert.equal(folder().getAttribute('aria-expanded'), 'true');
		key('Enter');
		assert.equal(folder().getAttribute('aria-expanded'), 'false');
		key(' ');
		assert.equal(folder().getAttribute('aria-expanded'), 'true');
		assert.equal(opened.length, opensBeforeFolder, 'Directory navigation never opens a file');
		tree.querySelector<HTMLButtonElement>('[aria-label="Open src/nested/two.ts"]')!.click();
		assert.deepEqual(opened.at(-1), { path: 'src/nested/two.ts', pinned: false });
		using otherRepository = scm.registerSCMProvider({ ...provider, id: 'repo-2' });
		group().querySelector<HTMLElement>('.ash-tree-twistie')!.click();
		views.selectRepository(otherRepository.id);
		assert.equal(group().getAttribute('aria-expanded'), 'true', 'Repositories do not share group identities');
	} finally {
		resetNlsResolver();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test('SCM input keeps repository drafts, updates help verbosity and releases its editor', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	try {
		const { registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
		const { ICodeEditorService } = await import('../../../../../editor/browser/services/codeEditorService.js');
		const { SCMInputWidget } = await import('../../browser/scmInput.js');
		await import('../../../accessibility/browser/accessibilityConfiguration.js');
		using configuration = new InMemoryConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		registerCodeEditorServices(services);
		using input = services.createInstance(SCMInputWidget, browser.window.document.body);
		const first = { ...testSCMProvider('first', 'First').input, enabled: true, value: 'First draft' };
		const second = { ...testSCMProvider('second', 'Second').input, enabled: true, value: 'Second draft' };
		const editors = services.get(ICodeEditorService);
		const editor = editors.listCodeEditors()[0];
		input.input = first;
		editor.getModel()!.setValue('Edited first draft');
		input.input = second;
		editor.getModel()!.setValue('Edited second draft');
		input.input = first;
		assert.deepEqual([first.value, second.value, editor.getModel()!.getValue()], ['Edited first draft', 'Edited second draft', 'Edited first draft']);
		const editorInput = input.domNode.querySelector('.stanza-editor-input')!;
		assert.match(editorInput.getAttribute('aria-label')!, /Alt\+F1/u);
		await configuration.updateValue('accessibility.verbosity.scmInput', false);
		assert.equal(editorInput.getAttribute('aria-label'), 'Commit message');
		await assert.rejects(configuration.updateValue('accessibility.verbosity.scmInput', 'false'), /must be a boolean/u);
		input.dispose();
		assert.equal(editors.listCodeEditors().length, 0);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) { Reflect.deleteProperty(globalThis, name); }
	}
});

test("ScmViewPane groups App Server Git status", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let requestCount = 0;
	let stagedPaths: readonly string[] | undefined;
	let discardCalls = 0;
	let stagedRepositoryId: string | undefined;
	let completeStage: (() => void) | undefined;
	let committedMessage: string | undefined;
	let committedRepositoryId: string | undefined;
	let statusListener: ((status: GitStatus) => void) | undefined;
	const repositoryStatusChanges = new Emitter<GitStatus>();
	statusListener = status => repositoryStatusChanges.fire(status);
	const changeFileRequests: Array<{ readonly path: string; readonly comparison: "staged" | "unstaged"; readonly repositoryId: string | undefined; }> = [];
	const opened: Array<{ readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target?: EditorOpenTarget; }> = [];
	const first: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream-1",
		revision: 1,
		workspacePath: "/workspace",
		head: {
			type: "branch",
			name: "main",
			objectId: "1234567890",
			upstream: { name: "origin/main", ahead: 2, behind: 1 },
		},
		changes: [
			change("staged.ts", "added", "unmodified"),
			change("src/working.ts", "unmodified", "modified"),
			change("both.ts", "modified", "modified"),
			{ ...change("conflict.ts", "unmerged", "unmerged"), conflicted: true },
		],
	};
	const committedClean: GitStatus = {
		repositoryId: first.repositoryId,
		streamInstanceId: first.streamInstanceId,
		revision: 2,
		workspacePath: first.workspacePath,
		head: first.head,
		changes: [],
	};
	const external: GitStatus = {
		...first,
		revision: 3,
	};
	const nestedStatus: GitStatus = {
		repositoryId: "repo-2",
		streamInstanceId: "git-stream-2",
		revision: 1,
		workspacePath: "/workspace/nested",
		head: { type: "branch", name: "nested", objectId: "2345678901", upstream: undefined },
		changes: [],
	};
	const repositories = [
		{ id: first.repositoryId, label: "workspace", path: "", root: URI.file("/workspace") },
		{ id: nestedStatus.repositoryId, label: "nested", path: "nested", root: URI.file("/workspace/nested") },
	];
	let repositoryList = repositories;
	using repositoryChanges = new Emitter<readonly GitRepository[]>();
	let activeRepository: GitRepository | undefined = repositories[0];
	const activeRepositoryChanges = new Emitter<GitRepository | undefined>();
	const readyChanges = new Emitter<void>();
	let workspaceError: GitWorkspaceError | undefined;
	let dirtyConflict = false;
	const workingCopies = {
		get: (resource: URI) => resource.path.endsWith('/conflict.ts') && dirtyConflict ? [{ isDirty: true }] : [],
	} as unknown as IWorkingCopyService;
	const selectedRepositories: string[] = [];
	const gitService = {
		get repositories() { return repositoryList; },
		get activeRepository() { return activeRepository; },
		onDidChangeRepositories: repositoryChanges.event,
		onDidChangeActiveRepository: activeRepositoryChanges.event,
		selectRepository: async (repositoryId: string) => {
			selectedRepositories.push(repositoryId);
			activeRepository = repositories.find(repository => repository.id === repositoryId)!;
			return nestedStatus;
		},
		status: async (repositoryId?: string) => {
			requestCount += 1;
			if (workspaceError) throw workspaceError;
			return repositoryId === nestedStatus.repositoryId ? nestedStatus : first;
		},
		stage: (paths: readonly string[], repositoryId?: string) => new Promise<GitStatus>((resolve) => {
			stagedPaths = paths;
			stagedRepositoryId = repositoryId;
			completeStage = () => resolve(first);
		}),
		unstage: async () => first,
		discardWorktree: async () => { discardCalls += 1; return first; },
		commit: async (message: string, repositoryId?: string) => {
			committedMessage = message;
			committedRepositoryId = repositoryId;
			return { objectId: "abcdef123456", status: committedClean };
		},
		fetch: async () => first,
		pull: async () => first,
		push: async () => first,
		changeFile: async (path: string, comparison: "staged" | "unstaged", repositoryId?: string) => {
			changeFileRequests.push({ path, comparison, repositoryId });
			return comparison === "staged"
				? { original: { kind: "text" as const, text: "head\n" }, modified: { kind: "text" as const, text: "index\n" } }
				: { original: { kind: "text" as const, text: "index\n" }, modified: { kind: "text" as const, text: "worktree\n" } };
		},
		onDidChangeRepositoryStatus: repositoryStatusChanges.event,
		onDidChangeStatus: repositoryStatusChanges.event,
		onDidBecomeReady: readyChanges.event,
	} as unknown as IGitService;

	try {
		await import("../../browser/scm.contribution.js");
		const { ScmViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmViewPane.js");
		const editorService = testEditorService(opened);
		const services = new InstantiationService();
		services.registerInstance(IGitService, gitService);
		services.registerInstance(IEditorService, editorService);
		using commandService = new CommandService(services);
		using actionRegistration = registerAction2(OpenScmMultiDiffEditorAction);
		using scmService = new SCMService();
		using viewService = new SCMViewService(scmService);
		using decorationServices = createTestEditorServices();
		using contribution = new GitSCMContribution(gitService, scmService, viewService, testGitProviderServices({
			commandService, editorService, workingCopyService: workingCopies,
			dialogService: { ...testDialogs, confirm: async () => ({ confirmed: false }) },
		}), decorationServices.get(IDecorationsService));
		using configuration = new InMemoryConfigurationService();
		services.registerInstance(IConfigurationService, configuration);
		const { registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
		registerCodeEditorServices(services);
		using titleCommands = new CommandService(services);
		using pane = new ScmViewPane(browser.window.document.body, {
			id: VIEW_PANE_ID,
			title: "Changes",
		}, scmService, viewService, testResourceLabelService(), testContextMenuProvider, configuration, testFileIconThemeService(), services, new MenuService(titleCommands, decorationServices.get(IContextKeyService)), decorationServices.get(IContextKeyService), decorationServices.get(IStorageService));
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "4 changed files");

		assert.equal(pane.element.querySelector(".ash-scm-branch"), null);
		assert.equal(pane.element.querySelector(".ash-scm-summary"), null);
		assert.ok(pane.element.querySelector(".ash-scm-status")?.classList.contains("ash-aria-live"));
		assert.deepEqual(
			[...pane.element.querySelectorAll(".ash-scm-section-heading > span:first-child")].map((element) => element.textContent),
			["Merge Changes", "Staged Changes", "Changes"],
		);
		assert.deepEqual(
			[...pane.element.querySelectorAll(".ash-scm-section-count")].map((element) => element.textContent),
			["1", "2", "2"],
		);

		const workingLabel = [...pane.element.querySelectorAll<HTMLElement>(".ash-scm-change-label")]
			.find((element) => element.querySelector(".ash-icon-label-text")?.textContent === "working.ts");
		assert.ok(workingLabel);
		assert.equal(workingLabel.querySelector(".ash-icon-label-description")?.textContent, "src");
		assert.equal(workingLabel.querySelector(".ash-icon-label-icon")?.getAttribute("data-file-icon"), "working.ts");
		assert.equal(pane.element.querySelector<HTMLButtonElement>('button[aria-label="Open merge conflict in conflict.ts"]')?.disabled, false);

		const stagedOpen = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Open staged changes for staged.ts"]');
		assert.ok(stagedOpen);
		stagedOpen.click();
		await waitFor(() => opened.length === 1);
		assert.deepEqual(changeFileRequests[0], { path: "staged.ts", comparison: "staged", repositoryId: first.repositoryId });
		assert.equal(opened[0].input.contentType, "application/vnd.stanza.editor-diff");
		assert.equal(opened[0].input.label, "staged.ts (HEAD) ↔ staged.ts (Index)");
		assert.equal(opened[0].options?.pinned, false);

		const workingOpen = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Open changes for src/working.ts"]');
		assert.ok(workingOpen);
		workingOpen.click();
		await waitFor(() => opened.length === 2);
		assert.deepEqual(changeFileRequests[1], { path: "src/working.ts", comparison: "unstaged", repositoryId: first.repositoryId });
		assert.equal(opened[1].input.contentType, "application/vnd.stanza.editor-diff");
		assert.equal(opened[1].input.label, "working.ts (Index) ↔ working.ts (Working Tree)");
		assert.equal(opened[1].options?.pinned, false);

		workingOpen.dispatchEvent(new browser.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
		await waitFor(() => opened.length === 3);
		assert.equal(opened[2].options?.pinned, true);

		const viewAllChanges = pane.element.querySelector<HTMLButtonElement>('button[aria-label="View All Changes"]');
		assert.ok(viewAllChanges);
		assert.ok(viewAllChanges.querySelector(".ash-icon"));
		viewAllChanges.click();
		await waitFor(() => opened.length === 4);
		assert.equal(opened[3].input.contentType, "application/vnd.stanza.editor-multi-diff");
		const multiDiffInput = opened[3].input as IResourceEditorInput & { readonly items: readonly { readonly goToFile?: IResourceEditorInput; }[]; };
		assert.equal(multiDiffInput.items.length, 2);
		assert.deepEqual(multiDiffInput.items.map((item) => item.goToFile?.resource.toString()), [
			"file:///workspace/src/working.ts",
			"file:///workspace/both.ts",
		]);
		assert.equal(opened[3].options?.pinned, true);
		const conflictOpen = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Open merge conflict in conflict.ts"]');
		assert.ok(conflictOpen);
		const changeFileCount = changeFileRequests.length;
		conflictOpen.click();
		await waitFor(() => opened.length === 5);
		const conflictInput = opened[4].input;
		assert.ok(isScmMergeEditorInput(conflictInput));
		assert.equal(conflictInput.resource.toString(), 'git-merge:/repo-1/conflict.ts');
		assert.equal(conflictInput.resultResource.toString(), 'file:///workspace/conflict.ts');
		assert.equal(conflictInput.readOnly, undefined);
		assert.equal(opened[4].options?.pinned, false);
		assert.equal(changeFileRequests.length, changeFileCount);

		workingOpen.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true, altKey: true }));
		await waitFor(() => opened.length === 6);
		assert.deepEqual({ options: opened[5].options, target: opened[5].target }, {
			options: { pinned: false, preserveFocus: true }, target: 'sideGroup',
		});
		conflictOpen.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true }));
		await waitFor(() => opened.length === 7);
		assert.ok(isScmMergeEditorInput(opened[6].input));
		assert.deepEqual({ options: opened[6].options, target: opened[6].target }, {
			options: { pinned: true, preserveFocus: false }, target: 'sideGroup',
		});
		stagedOpen.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
		await waitFor(() => opened.length === 8);
		assert.deepEqual({ options: opened[7].options, target: opened[7].target }, {
			options: { pinned: false, preserveFocus: true }, target: undefined,
		});
		dirtyConflict = true;
		pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage conflict.ts"]')?.click();
		assert.equal(stagedPaths, undefined);
		assert.equal(pane.element.querySelector('.ash-scm-status')?.textContent, 'Save conflict.ts before staging its conflict resolution.');
		dirtyConflict = false;

		const stageAll = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage All Changes"]');
		const discardAll = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Discard All Changes"]');
		assert.ok(stageAll?.querySelector(".ash-icon"));
		assert.ok(discardAll?.querySelector(".ash-icon"));
		const unstageAll = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Unstage All Changes"]');
		const unstage = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Unstage staged.ts"]');
		assert.ok(unstageAll?.querySelector(".ash-icon"));
		assert.ok(unstage?.querySelector(".ash-icon"));

		const stage = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage src/working.ts"]');
		const discard = pane.element.querySelector<HTMLButtonElement>('button[aria-label="Discard src/working.ts"]');
		assert.ok(stage);
		assert.ok(stage.querySelector(".ash-icon"));
		assert.ok(discard?.querySelector(".ash-icon"));
		discard?.click();
		await Promise.resolve();
		assert.equal(discardCalls, 0);
		stage.click();
		await waitFor(() => stagedPaths !== undefined);
		assert.deepEqual(stagedPaths, ["src/working.ts"]);
		assert.equal(stagedRepositoryId, first.repositoryId);
		assert.equal(pane.element.contains(stage), true);
		assert.equal(pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage src/working.ts"]')?.disabled, true);
		assert.equal(pane.element.querySelector<HTMLButtonElement>('button[aria-label="View All Changes"]')?.disabled, true);
		assert.ok(completeStage);
		completeStage();
		await waitFor(() => pane.element.querySelector<HTMLButtonElement>('button[aria-label="Stage src/working.ts"]')?.disabled === false);

		const message = pane.element.querySelector<HTMLElement>('.ash-scm-input .stanza-editor-input');
		const commit = pane.element.querySelector<HTMLButtonElement>(".ash-scm-commit");
		assert.ok(message);
		assert.ok(commit);
		assert.ok(commit.classList.contains("ash-button"));
		assert.ok(commit.classList.contains("label-centered"));
		assert.equal(commit.textContent, "Commit");
		assert.ok(commit.querySelector(".ash-icon"));
		await waitFor(() => !commit.disabled);
		const { ICodeEditorService } = await import('../../../../../editor/browser/services/codeEditorService.js');
		services.get(ICodeEditorService).listCodeEditors()[0].getModel()!.setValue('ship scm');
		commit.click();
		await waitFor(() => committedMessage !== undefined);
		assert.equal(committedMessage, "ship scm");
		assert.equal(committedRepositoryId, first.repositoryId);
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent?.startsWith("Created commit abcdef1.") === true);

		assert.ok(statusListener);
		statusListener(external);
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "4 changed files");

		assert.equal(pane.element.querySelector('select'), null);
		const hoverService: IHoverService = { setupDelayedHover: () => testManagedHover(), setupHover: () => testManagedHover(), showHover: () => testManagedHover(), hideHover() { } };
		using repositoriesPane = new SCMRepositoriesViewPane(browser.window.document.body, { id: 'workbench.scm.repositories', title: 'Repositories' }, scmService, viewService, hoverService, configuration);
		repositoriesPane.setVisible(true);
		const repositoryRows = repositoriesPane.element.querySelectorAll<HTMLElement>('[role="option"]');
		assert.deepEqual([...repositoryRows].map(row => row.querySelector('.ash-scm-repository-name')?.textContent), ['workspace', 'nested']);
		repositoryRows[1].click();
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "No changes.");
		assert.deepEqual(selectedRepositories, [nestedStatus.repositoryId]);
		assert.equal(repositoryRows[1].getAttribute('aria-selected'), 'true');

		assert.equal(requestCount, 3);

		workspaceError = new GitWorkspaceError('noFolder');
		activeRepository = undefined;
		repositoryList = [];
		repositoryChanges.fire(repositoryList);
		activeRepositoryChanges.fire(undefined);
		await waitFor(() => pane.shouldShowWelcome());
		assert.equal(pane.element.querySelector<HTMLElement>('.ash-view-welcome')?.hidden, false);
		assert.equal(pane.element.querySelector<HTMLElement>('.ash-scm-status')?.hidden, true);
		assert.equal(pane.element.querySelectorAll('.ash-scm-change').length, 0);
		assert.equal(pane.element.querySelector<HTMLButtonElement>('.ash-scm-commit')?.disabled, true);

		workspaceError = undefined;
		activeRepository = repositories[0];
		repositoryList = repositories;
		repositoryChanges.fire(repositoryList);
		activeRepositoryChanges.fire(activeRepository);
		await waitFor(() => pane.element.querySelector<HTMLButtonElement>('.ash-scm-commit')?.disabled === false);
		readyChanges.fire();
		await waitFor(() => pane.element.querySelector('.ash-scm-status')?.textContent === '4 changed files');
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test("ScmViewPane accepts a restarted Git stream and rejects its retired predecessor", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	let statusRequest = 0;
	let statusListener: ((status: GitStatus) => void) | undefined;
	let readyListener: (() => void) | undefined;
	const repositoryStatusChanges = new Emitter<GitStatus>();
	const readyChanges = new Emitter<void>();
	statusListener = status => repositoryStatusChanges.fire(status);
	readyListener = () => readyChanges.fire();
	const previous: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream-before-restart",
		revision: 20,
		workspacePath: "/workspace",
		head: { type: "branch", name: "before", objectId: "1111111", upstream: undefined },
		changes: [change("before.ts", "unmodified", "modified")],
	};
	const restarted: GitStatus = {
		repositoryId: "repo-1",
		streamInstanceId: "git-stream-after-restart",
		revision: 1,
		workspacePath: "/workspace",
		head: { type: "branch", name: "after", objectId: "2222222", upstream: undefined },
		changes: [],
	};
	const latePrevious: GitStatus = {
		...previous,
		revision: 21,
		head: { type: "branch", name: "late-before", objectId: "3333333", upstream: undefined },
	};
	const gitService = {
		repositories: [{ id: 'repo-1', label: 'workspace', path: '/workspace', root: URI.file('/workspace') }],
		activeRepository: undefined,
		onDidChangeRepositories: noEvent,
		onDidChangeActiveRepository: noEvent,
		status: async () => statusRequest++ === 0 ? previous : restarted,
		onDidChangeRepositoryStatus: repositoryStatusChanges.event,
		onDidBecomeReady: readyChanges.event,
	} as unknown as IGitService;

	try {
		const { ScmViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmViewPane.js");
		using scmService = new SCMService();
		using viewService = new SCMViewService(scmService);
		using provider = new GitSCMProvider(gitService, gitService.repositories[0], {} as GitHistoryProvider, testGitProviderServices());
		using repository = scmService.registerSCMProvider(provider);
		using configuration = new InMemoryConfigurationService();
		using editorServices = createTestEditorServices(configuration, undefined, browser.window.document);
		const { registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
		registerCodeEditorServices(editorServices);
		using titleCommands = new CommandService(editorServices);
		using pane = new ScmViewPane(browser.window.document.body, {
			id: "ash.git.restart",
			title: "Changes",
		}, scmService, viewService, testResourceLabelService(), testContextMenuProvider, configuration, testFileIconThemeService(), editorServices, new MenuService(titleCommands, editorServices.get(IContextKeyService)), editorServices.get(IContextKeyService), editorServices.get(IStorageService));
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector('[aria-label="Open changes for before.ts"]') !== null);
		assert.equal(pane.element.querySelector(".ash-scm-branch"), null);

		assert.ok(readyListener);
		readyListener();
		await waitFor(() => pane.element.querySelector(".ash-scm-status")?.textContent === "No changes.");
		assert.equal(statusRequest, 2);

		assert.ok(statusListener);
		statusListener(latePrevious);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(pane.element.querySelector(".ash-scm-status")?.textContent, "No changes.");
		assert.equal(pane.element.querySelector('[aria-label="Open changes for before.ts"]'), null);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

function change(path: string, indexStatus: GitStatus["changes"][number]["indexStatus"], worktreeStatus: GitStatus["changes"][number]["worktreeStatus"]): GitStatus["changes"][number] {
	return {
		path,
		originalPath: undefined,
		indexStatus,
		worktreeStatus,
		conflicted: false,
		submodule: {
			isSubmodule: false,
			commitChanged: false,
			trackedChanges: false,
			untrackedChanges: false,
		},
	};
}

function testManagedHover(): IManagedHover {
	return {
		visible: false,
		show() { },
		hide() { },
		update() { },
		dispose() { },
		[Symbol.dispose]() { },
	};
}

function testEditorService(opened: Array<{ readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target?: EditorOpenTarget; }> = []): IEditorService {
	return {
		...emptyEditorServiceState,
		openEditor: async (input, options, target) => { opened.push({ input, options, target }); },
		focusActiveEditor() { },
	};
}

function testResourceLabelService(resourceIconRenderer = testFileIconThemeService()): IResourceLabelService {
	return { createGroup: () => new ResourceLabels(DEFAULT_LABELS_CONTAINER, { workspaceContextService: testWorkspaceContext(), resourceIconRenderer }) };
}

function testFileIconThemeService(): IResourceIconRenderer {
	return {
		onDidChangeResourceIcons: () => ({ dispose(): void { }, [Symbol.dispose](): void { } }),
		getFileIconTheme: () => ({ ...noFileIconTheme, hasFileIcons: true }),
		renderFileIcon: (resource, container) => { container.dataset.fileIcon = decodeURIComponent(resource.toEncodedComponents().path.split("/").at(-1) ?? ""); },
	};
}

const testContextMenuProvider: IContextMenuService = {
	onDidShowContextMenu: Event.None,
	onDidHideContextMenu: Event.None,
	showContextMenu() { },
	hideContextMenu() { },
};

function inactiveCommandService(): ICommandService {
	return {
		executeCommand: async () => undefined,
	} as unknown as ICommandService;
}

function testGitProviderServices(overrides: Partial<GitSCMProviderServices> = {}): GitSCMProviderServices {
	return {
		commandService: inactiveCommandService(),
		dialogService: testDialogs,
		editorService: testEditorService(),
		viewsService: { focusView: async () => true } as unknown as IViewsService,
		workingCopyService: { get: () => [] } as unknown as IWorkingCopyService,
		...overrides,
	};
}

function testWorkspaceContext(): IWorkspaceContextService {
	return {
		onDidChangeWorkspace: Event.None,
		getWorkbenchState: () => WorkbenchState.EMPTY,
		getWorkspace: () => ({ id: 'empty', folders: [] }),
		getWorkspaceFolder: () => null,
	};
}

function testSCMProvider(id: string, label: string, historyProvider?: ISCMHistoryProvider): ISCMProvider {
	return {
		id, providerId: 'git', label, historyProvider,
		groups: [], onDidChangeResources: Event.None,
		input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
		activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', isBusy: false,
		refresh: async () => { }, activate: async () => { },
	};
}

async function waitFor(condition: () => boolean, timeoutMillis = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for ScmViewPane");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function noEvent(): { dispose(): void;[Symbol.dispose](): void; } {
	const dispose = (): void => undefined;
	return { dispose, [Symbol.dispose]: dispose };
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	// jsdom has no layout. Model the shared list's viewport and content dimensions, not the pane's outer scroll.
	Object.defineProperties(browser.window.HTMLElement.prototype, {
		clientHeight: {
			configurable: true,
			get(this: HTMLElement): number {
				if (this.classList.contains('ash-scm-graph')) return 600;
				return this.classList.contains('ash-scrollbar-viewport') ? this.closest<HTMLElement>('.ash-scm-graph')?.clientHeight ?? 0 : 0;
			},
		},
		clientWidth: {
			configurable: true,
			get(this: HTMLElement): number {
				return this.classList.contains('ash-scrollbar-viewport') ? 320 : 0;
			},
		},
		scrollHeight: {
			configurable: true,
			get(this: HTMLElement): number {
				return this.classList.contains('ash-scrollbar-viewport') ? Number.parseFloat(this.querySelector<HTMLElement>('.ash-list')?.style.height ?? '0') : 0;
			},
		},
	});
	class TestResizeObserver {
		public observe(): void { }
		public unobserve(): void { }
		public disconnect(): void { }
	}
	browser.window.HTMLCanvasElement.prototype.getContext = () => null;
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		HTMLCanvasElement: browser.window.HTMLCanvasElement,
		NodeFilter: browser.window.NodeFilter,
		InputEvent: browser.window.InputEvent,
		ResizeObserver: TestResizeObserver,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		KeyboardEvent: browser.window.KeyboardEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	return Object.keys(globals);
}
test("SCM distinguishes an empty window, a folder without Git, and unavailable access", async () => {
	const [{ gitErrorMessage }, { GitWorkspaceError }] = await Promise.all([
		import("../../../../../workbench/contrib/git/common/gitError.js"),
		import("../../../../../workbench/contrib/git/common/gitService.js"),
	]);
	assert.deepEqual([
		gitErrorMessage(new GitWorkspaceError('noFolder')),
		gitErrorMessage(new GitWorkspaceError('noRepository')),
		gitErrorMessage(new Error("Error invoking remote method 'ash:git:status': JsonRpcRemoteError: GitUnavailable")),
	], [
		'Open a folder to use Git.',
		'No Git repository found in the open folder.',
		'Git is unavailable for this workspace. Check folder access and retry.',
	]);
});

suite('SCM badge and decorations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepted Git status updates shared decorations and deduplicated activity while retaining each SCM side', async () => {
		using changes = new Emitter<GitStatus>();
		using repositoryChanges = new Emitter<readonly GitRepository[]>();
		const repository: GitRepository = { id: 'repo', label: 'workspace', path: '/workspace', root: URI.file('/workspace') };
		let repositories = [repository];
		const status: GitStatus = { repositoryId: 'repo', streamInstanceId: 'stream', revision: 1, workspacePath: '/workspace', head: { type: 'unborn', name: 'main' }, changes: [change('src/both.ts', 'added', 'modified')] };
		const git = { get repositories() { return repositories; }, activeRepository: repository, onDidChangeRepositories: repositoryChanges.event, onDidChangeActiveRepository: Event.None, onDidBecomeReady: Event.None, onDidChangeRepositoryStatus: changes.event, status: async () => status } as unknown as IGitService;
		const dom = new JSDOM('<!doctype html><head></head><body></body>');
		using documentLifetime = toDisposable(() => dom.window.close());
		using services = createTestEditorServices(undefined, undefined, dom.window.document);
		using scm = new SCMService();
		using view = new SCMViewService(scm);
		let activityCount: number | undefined;
		let activityDescription: string | undefined;
		using activity = new ActivityService({ setBadge: (_id: string, count: number | undefined, description?: string) => { activityCount = count; activityDescription = description; } } as CompositeBar);
		services.registerInstance(ISCMViewService, view);
		services.registerInstance(IActivityService, activity);
		const decorations = services.get(IDecorationsService);
		using contribution = services.createInstance(GitSCMContribution, git, scm, view, testGitProviderServices());
		using controller = services.createInstance(SCMActiveRepositoryController);
		await waitFor(() => activityCount === 1);
		assert.match(scm.getRepository('repo')!.provider.input.placeholder, /to commit on "main"/u);
		assert.deepEqual(scm.getRepository('repo')!.provider.groups.map(group => [group.id, group.resources[0]!.decorations.badge]), [['staged', 'A'], ['changes', 'M']]);
		const resource = URI.file('/workspace/src/both.ts');
		using modified = decorations.getDecoration(resource, false)!;
		assert.equal(modified.tooltip, 'Modified');
		using folder = decorations.getDecoration(URI.file('/workspace/src'), true)!;
		assert.match(folder.tooltip, /Contains Git changes/u);
		assert.equal(activityDescription, '1 changed file');
		changes.fire({ ...status, revision: 2, changes: [...status.changes, change('src/other.ts', 'unmodified', 'untracked')] });
		assert.equal(activityCount, 2);
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		try {
			setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
			assert.equal(activityDescription, '2 changed files');
			changes.fire({ ...status, revision: 3, changes: [...status.changes, change('src/other.ts', 'unmodified', 'untracked')] });
			assert.equal(activityDescription, '2 个已更改文件');
			using translated = decorations.getDecoration(resource, false)!;
			assert.equal(translated.tooltip, '已修改');
		} finally {
			resetNlsResolver();
		}
		changes.fire({ ...status, revision: 4, changes: [change('src/both.ts', 'added', 'unmodified')] });
		using staged = decorations.getDecoration(resource, false)!;
		assert.equal(staged.tooltip, 'Added');
		changes.fire(status);
		using accepted = decorations.getDecoration(resource, false)!;
		assert.equal(accepted.tooltip, 'Added');
		view.selectRepository(undefined);
		assert.equal(activityCount, undefined);
		view.selectRepository('repo');
		assert.equal(activityCount, 1);
		const states = [
			['modified', 'M', 'Modified', 'modifiedResourceForeground'],
			['added', 'A', 'Added', 'addedResourceForeground'],
			['deleted', 'D', 'Deleted', 'deletedResourceForeground'],
			['renamed', 'R', 'Renamed', 'renamedResourceForeground'],
			['copied', 'C', 'Copied', 'addedResourceForeground'],
			['typeChanged', 'T', 'Type changed', 'modifiedResourceForeground'],
			['untracked', 'U', 'Untracked', 'untrackedResourceForeground'],
		] as const;
		changes.fire({
			...status, revision: 5, changes: [
				...states.map(([state]) => change(`src/${state}.ts`, 'unmodified', state)),
				{ ...change('src/conflict.ts', 'added', 'modified'), conflicted: true },
			]
		});
		assert.equal(activityCount, 8);
		for (const [state, badge, tooltip, color] of states) {
			const uri = URI.file(`/workspace/src/${state}.ts`);
			using decoration = decorations.getDecoration(uri, false)!;
			assert.equal(decoration.tooltip, tooltip);
			assert.equal(decoration.isTextBadge, true);
			assert.equal(decoration.strikethrough, state === 'deleted');
			const data = (scm.getRepository('repo')!.provider as GitSCMProvider).provideDecorations(uri)!;
			assert.equal(data.letter, badge);
			assert.equal(data.color, `gitDecoration.${color}`);
		}
		const conflicting = (scm.getRepository('repo')!.provider as GitSCMProvider).provideDecorations(URI.file('/workspace/src/conflict.ts'))!;
		assert.equal(conflicting.tooltip, 'Merge conflict');
		assert.equal(conflicting.color, 'gitDecoration.conflictingResourceForeground');
		assert.equal(scm.getRepository('repo')!.provider.groups[0]!.resources[0]!.decorations.kind, 'unmerged');
		assert.equal((scm.getRepository('repo')!.provider as GitSCMProvider).provideDecorations(URI.file('/workspace/src'))!.color, conflicting.color);
		changes.fire({ ...status, revision: 6, changes: [] });
		assert.equal(activityCount, undefined);
		assert.equal(decorations.getDecoration(resource, false), undefined);
		assert.equal(decorations.getDecoration(URI.file('/workspace/src'), true), undefined);
		repositories = [];
		repositoryChanges.fire(repositories);
		assert.equal(scm.getRepository('repo'), undefined);
	});
});
