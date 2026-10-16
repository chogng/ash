import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { createTestComponentServices } from '../../../../test/common/testEditorServices.js';
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
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../../../nls.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { noFileIconTheme } from '../../../../../platform/theme/common/themeService.js';
import assert from "node:assert/strict";
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { observableValue } from '../../../../../base/common/observable.js';
import type { ISCMHistoryItemRef, ISCMHistoryProvider } from '../../common/history.js';
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
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import type { HoverSetupOptions, IHoverService, IManagedHover } from "../../../../../platform/hover/browser/hoverService.js";
import { IResourceLabelService, ResourceLabels, DEFAULT_LABELS_CONTAINER, IResourceIconRenderer } from "../../../../browser/labels.js";
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from "../../../../../workbench/services/editor/common/editorService.js";
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { WorkbenchState, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { CommandService } from "../../../../../workbench/services/commands/common/commandService.js";
import { isScmMergeEditorInput } from "../../../../../workbench/contrib/scm/browser/scmMergeEditorInput.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { SCMRepositoriesViewPane } from '../../browser/scmRepositoriesViewPane.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ISCMService, ISCMViewService, VIEW_PANE_ID, type ISCMProvider } from '../../common/scm.js';
import type { ScmViewPane } from '../../browser/scmViewPane.js';
import type { ISCMResourceGroup } from '../../common/scm.js';

const testHistoryClipboard = { writeText: async () => { assert.fail('Unexpected clipboard write'); } } as unknown as IClipboardService;
const testHistoryOpener = { open: async () => { assert.fail('Unexpected external opening'); } } as unknown as IOpenerService;

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
	using repository = scmService.registerSCMProvider(testSCMProvider('repo', 'repo', {} as ISCMHistoryProvider));
	assert.equal(viewService.activeRepository?.id, 'repo');
});

test("Git contribution registers Repositories before Changes and hides it for a single provider", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);

	try {
		const { WorkbenchViewRegistry, WorkbenchViewContainerId } = await import("../../../../../workbench/common/views.js");
		const { SCM_AGENT_REVIEW_VIEW_ID, SCM_HISTORY_VIEW_ID, registerSCMViews } = await import("../../../../../workbench/contrib/scm/browser/scm.contribution.js");
		using registry = new WorkbenchViewRegistry();

		registerSCMViews(registry);

		const views = registry.getViews(WorkbenchViewContainerId.SourceControl);
		assert.deepEqual(views.map((view) => view.id), ['workbench.scm.repositories', VIEW_PANE_ID, SCM_AGENT_REVIEW_VIEW_ID, SCM_HISTORY_VIEW_ID]);
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
		const { SCM_AGENT_REVIEW_VIEW_ID, SCM_HISTORY_VIEW_ID, registerSCMViews } = await import('../../browser/scm.contribution.js');
		using context = new ContextKeyService();
		using scm = new SCMService();
		using services = new InstantiationService();
		services.registerInstance(IContextKeyService, context);
		services.registerInstance(ISCMService, scm);
		using registry = new WorkbenchViewRegistry();
		registerSCMViews(registry);
		using model = new ViewContainerModel(registry.getViewContainer(WorkbenchViewContainerId.SourceControl)!, registry, context);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.scmRepositories']);
		host.advance(WorkbenchPhase.BlockRestore);
		const visiblePanes = (): readonly string[] => model.visibleViewDescriptors.map(view => view.id);
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);

		using repository = scm.registerSCMProvider(testSCMProvider('resources', 'Resources'));
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID, SCM_AGENT_REVIEW_VIEW_ID]);
		const history = historyProviderFixture();
		using historyRepository = scm.registerSCMProvider(testSCMProvider('history', 'History', history));
		assert.deepEqual(visiblePanes(), ['workbench.scm.repositories', VIEW_PANE_ID, SCM_AGENT_REVIEW_VIEW_ID, SCM_HISTORY_VIEW_ID]);

		historyRepository.dispose();
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID, SCM_AGENT_REVIEW_VIEW_ID]);
		repository.dispose();
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);

		using restoredRepository = scm.registerSCMProvider(testSCMProvider('restored', 'Restored', history));
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID, SCM_AGENT_REVIEW_VIEW_ID, SCM_HISTORY_VIEW_ID]);
		host.dispose();
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);
		using afterDisposal = scm.registerSCMProvider(testSCMProvider('after-disposal', 'After disposal', history));
		assert.deepEqual(visiblePanes(), [VIEW_PANE_ID]);
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
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
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
		}, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), scm);
		await waitFor(() => pane.element.querySelector('.ash-scm-empty') !== null);
		const firstOperation = new DeferredPromise<void>();
		const firstResult = pane.runTitleOperation(() => firstOperation.p);
		assert.equal(context.getValue('scmHistoryBusy'), true);
		const choosingRepository = pane.pickRepository();
		const repositoryOption = [...browser.window.document.querySelectorAll<HTMLElement>('.ash-quick-pick [role="option"]')].find(item => item.textContent?.includes('Second'))!;
		repositoryOption.click();
		await choosingRepository;
		assert.equal(view.activeRepository, second);
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
			refreshed: [], loaded: ['first', 'second'], busy: false,
		});
		await pane.runTitleOperation();
		assert.deepEqual({ refreshed, loaded }, { refreshed: ['second'], loaded: ['first', 'second', 'second'] }, 'Explicit refresh still bypasses the provider cache');
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


test('SCM history details expose copy and remote actions without extension menu entries', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	try {
		const { SCMHistoryViewPane } = await import('../../browser/scmHistoryViewPane.js');
		const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
		using context = new ContextKeyService();
		using services = new InstantiationService();
		const menus = new MenuService(new CommandService(services), context);
		using scm = new SCMService();
		services.registerInstance(ISCMService, scm);
		using view = new SCMViewService(scm);
		const id = 'abcdef0123456789';
		const uri = URI.parse(`https://github.com/test/history/commit/${id}`);
		const openedEditors: Parameters<typeof testEditorService>[0] = [];
		services.registerInstance(IEditorService, testEditorService(openedEditors));
		let requestedLimit: number | undefined;
		const provider: ISCMHistoryProvider = {
			onDidChange: Event.None, historyItemRef: observableValue('hoverHead', undefined), refresh() { },
			provideHistoryItems: async options => {
				requestedLimit = options.limit;
				return [{ id, displayId: 'abcdef0', parentIds: [], subject: 'Details', message: 'Details', remoteLinks: [{ name: 'origin', uri }], references: [{ id: 'tag:v1', name: 'v1', category: 'tag' }, { id: 'localBranch:topic', name: 'topic', category: 'localBranch' }] }];
			},
			resolveHistoryItemDetails: async () => ({ authorName: 'Author', authorEmail: 'author@example.invalid', timestamp: 1700000000000, message: 'Details\n\nFull message', statistics: { files: 1, additions: 2, deletions: 0 } }),
			provideHistoryItemChanges: async () => [{ uri: URI.file('/workspace/file.txt'), path: 'file.txt', status: 'added' }],
			resolveHistoryItemChangeContents: async () => ({ parentId: undefined, original: { kind: 'missing' }, modified: { kind: 'text', text: 'Committed contents' } }),
			resolveHistoryItemChatContext: async () => undefined,
			resolveHistoryItemChangeRangeChatContext: async () => undefined,
		};
		using registration = scm.registerSCMProvider(testSCMProvider('hover', 'Repository', provider));
		let hoverOptions: HoverSetupOptions | undefined;
		let copied: string | undefined;
		const opened: unknown[] = [];
		const hover: IHoverService = {
			setupDelayedHover: () => testManagedHover(),
			setupHover: options => { hoverOptions = options; return testManagedHover(); },
			showHover: () => testManagedHover(), hideHover() { },
		};
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
		await historyConfiguration.updateValue('scm.graph.pageSize', 3);
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: 'history.hover.test', title: 'Graph' }, view, menus, testContextMenuProvider as IContextMenuService, context, hover, testEditorService(), testResourceLabelService(), {
			show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp() { }, dispose() { }, [Symbol.dispose]() { },
		}, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } },
			{ writeText: async (text: string) => { copied = text; } } as unknown as IClipboardService,
			{ open: async (...args: unknown[]) => { opened.push(args); return true; } } as unknown as IOpenerService, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), scm);
		pane.setVisible(true);
		await waitFor(() => hoverOptions !== undefined);
		assert.equal(requestedLimit, 4, 'The initial page respects the configured size, with one item of look-ahead');
		const content = hoverOptions!.content;
		assert.ok(typeof content === 'function');
		const card = content(CancellationToken.None);
		assert.ok(card instanceof browser.window.HTMLElement);
		browser.window.document.body.append(card);
		await waitFor(() => card.querySelector('.ash-scm-graph-hover-message') !== null);
		const buttons = [...card.querySelectorAll<HTMLButtonElement>('.ash-scm-graph-hover-actions button')];
		assert.deepEqual(buttons.map(button => ({ label: button.getAttribute('aria-label'), text: button.textContent })), [
			{ label: 'Copy Commit Hash', text: '' }, { label: 'Open on GitHub', text: 'Open on GitHub' },
		]);
		buttons[0].click();
		await waitFor(() => copied !== undefined);
		assert.equal(copied, id, 'Copy uses the complete ID rather than the shortened display ID');
		buttons[1].click();
		await waitFor(() => opened.length > 0);
		assert.deepEqual(opened, [[uri, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }]]);
		assert.equal(card.querySelector('.ash-scm-graph-hover-message-scroll')?.getAttribute('aria-label'), 'Commit message');
		assert.equal(card.querySelector('.ash-scm-graph-hover-message')?.textContent, 'Full message');
		assert.deepEqual([...card.querySelectorAll('.ash-scm-graph-hover-references > span')].map(label => label.textContent), ['topic', 'v1']);
		const openCommit = card.querySelector<HTMLButtonElement>('.ash-scm-graph-hover-hash button')!;
		assert.equal(openCommit.getAttribute('aria-label'), 'Open Commit abcdef0');
		openCommit.click();
		await waitFor(() => openedEditors.length === 1);
		assert.ok(isMultiDiffEditorInput(openedEditors[0].input));
		assert.equal(openedEditors[0].input.resource.path, `/scm-history/hover/parent/${id}`);
	} finally {
		browser.window.close();
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
	}
});

test('SCM history restores a late HEAD and moves its marker without reloading or losing expansion', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	try {
		const { SCMHistoryViewPane } = await import('../../browser/scmHistoryViewPane.js');
		const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
		const { MenuService } = await import('../../../../../platform/actions/common/menuService.js');
		using context = new ContextKeyService();
		using services = new InstantiationService();
		const menus = new MenuService(new CommandService(services), context);
		using scm = new SCMService();
		using view = new SCMViewService(scm);
		const head = observableValue<ISCMHistoryItemRef | undefined>('lateHead', undefined);
		let queries = 0;
		const provider: ISCMHistoryProvider = {
			onDidChange: Event.None, historyItemRef: head, refresh: () => assert.fail('Unexpected refresh'),
			provideHistoryItems: async () => {
				queries++; return [
					{ id: 'one', parentIds: ['two'], subject: 'First commit', message: 'First commit', references: [] },
					{ id: 'two', parentIds: [], subject: 'Second commit', message: 'Second commit', references: [] },
				];
			},
			provideHistoryItemChanges: async () => [],
			resolveHistoryItemDetails: async () => { throw new Error('Unexpected details'); },
			resolveHistoryItemChangeContents: async () => { throw new Error('Unexpected contents'); },
			resolveHistoryItemChatContext: async () => undefined,
			resolveHistoryItemChangeRangeChatContext: async () => undefined,
		};
		using registration = scm.registerSCMProvider(testSCMProvider('late-head', 'Repository', provider));
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: 'history.lateHead.test', title: 'Graph' }, view, menus, {} as IContextMenuService, context, {
			setupDelayedHover: () => testManagedHover(), setupHover: () => testManagedHover(), showHover: () => testManagedHover(), hideHover() { },
		}, testEditorService(), testResourceLabelService(), {
			show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp() { }, dispose() { }, [Symbol.dispose]() { },
		}, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), scm);
		pane.setVisible(true);
		await waitFor(() => pane.element.querySelectorAll('.ash-scm-graph-commit').length === 2);
		const rows = [...pane.element.querySelectorAll<HTMLElement>('.ash-scm-graph-commit')];
		rows[0].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await waitFor(() => rows[0].getAttribute('aria-expanded') === 'true' && rows[0].querySelector('.ash-scm-graph-change-state')?.textContent === 'No changed files.');
		const loaded = queries;
		head.set({ id: 'localBranch:main', name: 'main', revision: 'one', category: 'localBranch' });
		assert.equal(rows[0].getAttribute('aria-current'), 'true');
		assert.equal(rows[0].querySelector('.ash-scm-graph-label.head')?.textContent, 'main');
		head.set(undefined);
		assert.equal(pane.element.querySelector('.ash-scm-graph-label.head'), null);
		head.set({ id: 'localBranch:topic', name: 'topic', revision: 'two', category: 'localBranch' });
		assert.equal(rows[0].hasAttribute('aria-current'), false);
		assert.equal(rows[1].getAttribute('aria-current'), 'true');
		assert.equal(rows[1].querySelector('.ash-scm-graph-label.head')?.textContent, 'topic');
		assert.equal(rows[0].getAttribute('aria-expanded'), 'true');
		assert.equal(rows[0].getAttribute('aria-selected'), 'true');
		assert.equal(rows[1].getAttribute('aria-selected'), 'false');
		assert.equal(pane.element.querySelectorAll('.ash-scm-graph-commit')[0], rows[0]);
		assert.equal(queries, loaded);
		rows[0].focus();
		rows[0].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(browser.window.document.activeElement, rows[1]);
		rows[1].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(browser.window.document.activeElement, rows[1], 'Navigation stops at the last commit');
		rows[1].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		assert.equal(browser.window.document.activeElement, rows[0]);
		rows[0].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		assert.equal(rows[0].getAttribute('aria-expanded'), 'false');
		rows[0].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await waitFor(() => rows[0].getAttribute('aria-expanded') === 'true');
		const reveal = menus.getMenuActions(MenuId.SCMHistoryTitle, { arg: pane }).flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.revealCurrentHistoryItem')!;
		assert.equal(reveal.enabled, true);
		services.registerInstance(IViewsService, { getActiveViewWithId: (id: string) => id === 'ash.gitGraph' ? pane : null } as unknown as IViewsService);
		await new CommandService(services).executeCommand('workbench.scm.action.graph.revealCurrentHistoryItem');
		assert.equal(browser.window.document.activeElement, rows[1], 'The title action uses the latest HEAD without reloading');
		assert.equal(queries, loaded);
		assert.equal(rows[1].getAttribute('aria-selected'), 'true', 'Go to Current selects the current history item');
		rows[0].dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
		assert.equal(rows[0].getAttribute('aria-selected'), 'true');
		assert.equal(rows[1].getAttribute('aria-selected'), 'false', 'Modified clicks still use the upstream single-selection policy');
		rows[1].dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
		assert.equal(rows[1].getAttribute('aria-selected'), 'true');
		assert.equal(rows[0].getAttribute('aria-selected'), 'false');
		rows[1].dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.equal(rows[1].getAttribute('aria-selected'), 'false');
		assert.equal(rows[1].getAttribute('aria-expanded'), 'true', 'Escape clears selection without collapsing files');
		pane.dispose();
		head.set({ id: 'HEAD', name: 'detached', revision: 'one' });
		assert.equal(rows[1].getAttribute('aria-current'), 'true', 'Disposed panes stop observing the old provider');
	} finally {
		browser.window.close();
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
	}
});

test("SCMHistoryViewPane loads another history page only on demand", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const graphRequests: GraphQuery[] = [];
	let failNextPage = true;
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
	const status = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		historyRevision: 1,
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
			if (query.cursor === '50' && failNextPage) { failNextPage = false; throw new Error('Temporary page failure'); }
			const start = query.cursor ? Number(query.cursor) : 0;
			const commits = Array.from({ length: Math.min(query.limit, 101 - start) }, (_, index) => ({
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
	} satisfies HistoryFixtureData;

	try {
		using history = createHistoryViewFixture(gitService);
		const { SCMHistoryViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js");
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.pagination.test", title: "Graph" }, history.viewService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), history.scmService);
		pane.setVisible(true);
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector('.ash-scm-graph .ash-list') !== null);
		const list = pane.element.querySelector('.ash-scm-graph .ash-list');
		const graph = pane.element.querySelector<HTMLElement>('.ash-scm-graph')!;
		const viewport = graph.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		await waitFor(() => graph.getAttribute('aria-busy') === 'false');
		const first = list!.querySelector('.ash-scm-graph-commit');
		assert.equal(first?.getAttribute('aria-setsize'), '50');
		assert.deepEqual(graphRequests, [{ limit: 51, revisions: ['commit-1'] }]);
		assert.equal(pane.element.querySelector('.ash-scm-graph .ash-list'), list);

		await assert.rejects(historyConfiguration.updateValue('scm.graph.pageSize', 0));
		await assert.rejects(historyConfiguration.updateValue('scm.graph.pageSize', 1001));
		await assert.rejects(historyConfiguration.updateValue('scm.graph.pageOnScroll', 'false'));
		await historyConfiguration.updateValue('scm.graph.pageOnScroll', false);
		viewport.scrollTop = 1100;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.equal(graphRequests.length, 1, 'A visible next-page button does not load when automatic paging is disabled');
		const loadMore = graph.querySelector<HTMLButtonElement>('.ash-scm-graph-load-more > button')!;
		assert.ok(loadMore);
		loadMore.focus();
		loadMore.click();
		await waitFor(() => graph.getAttribute('aria-busy') === 'false' && graphRequests.length === 2);
		assert.equal(list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize'), '50');
		const retry = graph.querySelector<HTMLButtonElement>('.ash-scm-graph-load-more > button')!;
		assert.equal(retry.getAttribute('aria-label'), 'Retry loading commit history');
		assert.equal(browser.window.document.activeElement, retry, 'A failed page returns keyboard focus to its live retry button');
		await historyConfiguration.updateValue('scm.graph.pageOnScroll', true);
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.equal(graphRequests.length, 2, 'A visible failed page waits for explicit retry instead of looping');
		await historyConfiguration.updateValue('scm.graph.pageOnScroll', false);
		retry.click();
		await waitFor(() => graph.getAttribute('aria-busy') === 'false' && graphRequests.length === 3);
		assert.equal(browser.window.document.activeElement?.querySelector('.ash-scm-graph-subject')?.textContent, 'History item 51');
		assert.equal(list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize'), '100');
		assert.deepEqual(graphRequests, [{ limit: 51, revisions: ['commit-1'] }, { limit: 51, cursor: '50', revisions: ['commit-1'] }, { limit: 51, cursor: '50', revisions: ['commit-1'] }]);
		assert.equal(list!.querySelectorAll('.ash-scm-graph-commit').length < 100, true);

		viewport.scrollTop = 2178;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		assert.equal(list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize'), '100');
		await historyConfiguration.updateValue('scm.graph.pageOnScroll', true);
		await waitFor(() => list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize') === '101');
		assert.equal(list!.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize'), '101');
		assert.equal(pane.element.querySelector('.ash-scm-graph-load-more'), null);
		assert.equal(graphRequests.length, 4);
		assert.equal(pane.element.querySelector('.ash-scm-graph .ash-list'), list);
	} finally {
		browser.window.close();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
	}
});

test('SCM history refresh retains loaded identities and folder focus and bounds a rewritten branch', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	try {
		const { SCMHistoryViewPane } = await import('../../browser/scmHistoryViewPane.js');
		const { ContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
		const { MenuService } = await import('../../../../../platform/actions/common/menuService.js');
		using context = new ContextKeyService();
		using services = new InstantiationService();
		using scm = new SCMService();
		using view = new SCMViewService(scm);
		using changed = new Emitter<void>();
		const makeItem = (id: string) => ({ id, parentIds: [], subject: id, message: id });
		let items = Array.from({ length: 30 }, (_, index) => makeItem(`original-${index}`));
		const head = observableValue<ISCMHistoryItemRef | undefined>('retainedHead', { id: 'refs/heads/main', name: 'main', revision: items[0].id, category: 'localBranch' });
		const queries: Array<{ skip: number; limit: number; }> = [];
		let reachable = true;
		let pauseNextQuery: DeferredPromise<void> | undefined;
		const provider: ISCMHistoryProvider = {
			onDidChange: changed.event, historyItemRef: head, refresh() { },
			provideHistoryItems: async options => {
				const skip = options.skip ?? 0;
				const limit = options.limit ?? 50;
				queries.push({ skip, limit });
				const result = items.slice(skip, skip + limit);
				const pause = pauseNextQuery;
				pauseNextQuery = undefined;
				await pause?.p;
				return result;
			},
			resolveHistoryItemRefsCommonAncestor: async refs => reachable ? refs[0] : undefined,
			provideHistoryItemChanges: async () => [{ uri: URI.parse('git:/src/history.txt'), path: 'src/history.txt', status: 'modified' }],
			resolveHistoryItemDetails: async () => { throw new Error('Unexpected details'); },
			resolveHistoryItemChangeContents: async () => { throw new Error('Unexpected contents'); },
			resolveHistoryItemChatContext: async () => undefined,
			resolveHistoryItemChangeRangeChatContext: async () => undefined,
		};
		using registration = scm.registerSCMProvider(testSCMProvider('retained', 'Repository', provider));
		await import('../../browser/scm.contribution.js');
		using configuration = new InMemoryConfigurationService();
		await configuration.updateValue('scm.graph.pageSize', 5);
		await configuration.updateValue('scm.graph.pageOnScroll', false);
		using uiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using quickInput = new TestQuickInputService({ container: browser.window.document.body });
		const hover: IHoverService = { setupDelayedHover: () => testManagedHover(), setupHover: () => testManagedHover(), showHover: () => testManagedHover(), hideHover() { } };
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: 'retained-state', title: 'Graph' }, view, new MenuService(new CommandService(services), context), testContextMenuProvider as IContextMenuService, context, hover, testEditorService(), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, configuration, quickInput, uiServices.get(IStorageService), scm);
		pane.setVisible(true);
		const graph = pane.element.querySelector<HTMLElement>('.ash-scm-graph')!;
		Object.defineProperty(graph, 'clientHeight', { configurable: true, value: 100 });
		browser.window.document.body.append(pane.element);
		await waitFor(() => graph.getAttribute('aria-busy') === 'false');
		graph.querySelector<HTMLButtonElement>('.ash-scm-graph-load-more > button')!.click();
		await waitFor(() => graph.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize') === '10');
		const viewport = graph.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		viewport.scrollTop = 88;
		viewport.dispatchEvent(new browser.window.Event('scroll'));
		const current = (): HTMLElement => graph.querySelector('[data-history-item-id="original-4"]')!;
		current().click();
		await waitFor(() => current().querySelector('.ash-scm-graph-change') !== null);
		pane.setViewMode('tree');
		const folder = (): HTMLButtonElement => current().querySelector('.ash-scm-graph-folder')!;
		folder().click();
		assert.equal(folder().getAttribute('aria-expanded'), 'false');
		folder().focus();
		const position = viewport.scrollTop;
		const prefix = Array.from({ length: 100 }, (_, index) => makeItem(`new-${index}`));
		items = [...prefix, ...items];
		head.set({ id: 'refs/heads/main', name: 'main', revision: items[0].id, category: 'localBranch' });
		changed.fire();
		await waitFor(() => graph.getAttribute('aria-busy') === 'false' && current()?.getAttribute('aria-setsize') === '110');
		assert.equal(current().getAttribute('aria-selected'), 'true');
		assert.equal(current().getAttribute('aria-expanded'), 'true');
		assert.equal(folder().getAttribute('aria-expanded'), 'false');
		assert.equal(browser.window.document.activeElement, folder(), 'Refresh returns to the same logical folder');
		assert.equal(viewport.scrollTop, position + 100 * 22);
		assert.ok(queries.every(query => query.limit <= 16));
		const beforeRewrite = queries.length;
		reachable = false;
		items = Array.from({ length: 200 }, (_, index) => makeItem(`rewritten-${index}`));
		head.set({ id: 'refs/heads/main', name: 'main', revision: items[0].id, category: 'localBranch' });
		changed.fire();
		await waitFor(() => graph.getAttribute('aria-busy') === 'false' && graph.querySelector('.ash-scm-graph-commit')?.getAttribute('aria-setsize') === '110');
		assert.equal(queries.length, beforeRewrite + 1, 'Unreachable retained IDs do not trigger an unbounded history search');
		assert.equal(graph.querySelector('[data-history-item-id="original-4"]'), null);
		assert.equal(graph.querySelectorAll('[role="treeitem"][aria-selected="true"]').length, 0);
		assert.equal((browser.window.document.activeElement as HTMLElement).dataset.historyItemId, 'rewritten-104');
		const deferred = new DeferredPromise<void>();
		pauseNextQuery = deferred;
		changed.fire();
		const outside = browser.window.document.createElement('input');
		browser.window.document.body.append(outside);
		outside.focus();
		await deferred.complete();
		await waitFor(() => graph.getAttribute('aria-busy') === 'false');
		assert.equal(browser.window.document.activeElement, outside, 'Completing an async refresh preserves another input’s newer focus');
	} finally {
		browser.window.close();
		for (const name of globals) Reflect.deleteProperty(globalThis, name);
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
	const status = {
		repositoryId: "repo-1",
		streamInstanceId: "git-graph-stream",
		historyRevision: 1,
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
	Object.assign(status, { head: { type: 'branch', name: 'main', objectId: 'commit-90', upstream: undefined } });
	const gitService = {
		onDidBecomeReady: noEvent,
		onDidChangeActiveRepository: noEvent,
		status: async () => status,
		branches: async () => [],
		graph: async (_query: GraphQuery) => ({ commits, references: [], remotes: [], hasMore: false, nextCursor: undefined }),
	} satisfies HistoryFixtureData;
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
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.virtualized.test", title: "Graph" }, history.viewService, menuService, {} as IContextMenuService, contextKeyService, hoverService, testEditorService(), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), history.scmService);
		pane.setVisible(true);
		const graph = pane.element.querySelector<HTMLElement>(".ash-scm-graph");
		assert.ok(graph);
		Object.defineProperty(graph, "clientHeight", { configurable: true, value: 100 });
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelectorAll(".ash-scm-graph-commit").length > 0);
		const viewport = graph.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		const reveal = menuService.getMenuActions(MenuId.SCMHistoryTitle, { arg: pane }).flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.revealCurrentHistoryItem')!;
		await reveal.run();
		assert.equal(browser.window.document.activeElement?.querySelector('.ash-scm-graph-subject')?.textContent, 'Commit 90', 'Locating HEAD loads the page containing an initially unloaded commit');
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
		firstCommit.focus();
		firstCommit.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		assert.equal(browser.window.document.activeElement?.querySelector('.ash-scm-graph-subject')?.textContent, 'Commit 99', 'End reveals and focuses an initially virtualized commit');
		browser.window.document.activeElement?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		assert.equal(browser.window.document.activeElement, firstCommit);
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
	using commandServices = new InstantiationService();
	const menuService = new MenuService(new CommandService(commandServices), contextKeyService);
	const objectId = "1".repeat(40);
	const parentObjectId = "2".repeat(40);
	let changeRequests = 0;
	let fileRequests = 0;
	let binary = false;
	const gitService = {
		onDidBecomeReady: noEvent,
		onDidChangeActiveRepository: noEvent,
		status: async (): Promise<{ workspacePath: string; head: { type: string; name: string; objectId: string; upstream: undefined; }; changes: unknown[]; repositoryId: string; streamInstanceId: string; revision: number; historyRevision: number; }> => ({
			repositoryId: "repo-1",
			streamInstanceId: "git-graph-stream",
			historyRevision: 1,
			revision: 1,
			workspacePath: ".",
			head: { type: "branch", name: "main", objectId, upstream: undefined },
			changes: [],
		}),
		branches: async () => [],
		graph: async () => ({
			commits: [{ objectId, parentObjectIds: [parentObjectId], timestampSeconds: 1_753_000_000, subject: "Change editor files" }],
			references: [{ name: "main", objectId, kind: "localBranch" as const, remoteName: undefined, current: true }, { name: "history-tag", objectId, kind: "tag" as const, remoteName: undefined, current: false }],
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
			return binary ? { original: { kind: 'binary', bytes: new Uint8Array([0, 1]) }, modified: { kind: 'binary', bytes: new Uint8Array([0, 255]) } } : { original: { kind: "text" as const, text: "before\n" }, modified: { kind: "text" as const, text: "after\n" } };
		},
	} satisfies HistoryFixtureData;
	const opened: Array<{ readonly input: IResourceEditorInput; readonly options: EditorOpenOptions | undefined; readonly target?: EditorOpenTarget; }> = [];
	const editorService = testEditorService(opened);
	commandServices.registerInstance(IEditorService, editorService);
	const hoverService: IHoverService = {
		setupDelayedHover: () => testManagedHover(),
		setupHover: () => testManagedHover(),
		showHover: () => testManagedHover(),
		hideHover() { },
	};
	const contextMenus: Array<{
		readonly menuId: MenuId;
		readonly onHide?: (cancelled: boolean) => void;
		readonly contextKeyService?: IContextKeyService;
		readonly menuActionOptions?: { readonly arg?: unknown; readonly args?: readonly unknown[]; };
	}> = [];
	const contextMenuService = {
		showContextMenu: (options: { readonly menuId: MenuId; readonly menuActionOptions?: { readonly arg?: unknown; readonly args?: readonly unknown[]; }; }) => contextMenus.push(options),
	} as unknown as IContextMenuService;

	try {
		using history = createHistoryViewFixture(gitService);
		const { SCMHistoryViewPane } = await import("../../../../../workbench/contrib/scm/browser/scmHistoryViewPane.js");
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: "ash.gitGraph.changes.test", title: "Graph" }, history.viewService, menuService, contextMenuService, contextKeyService, hoverService, editorService, testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), history.scmService);
		pane.setVisible(true);
		browser.window.document.body.append(pane.element);
		await waitFor(() => pane.element.querySelector(".ash-scm-graph-commit") !== null);

		const commit = pane.element.querySelector<HTMLElement>(".ash-scm-graph-commit");
		assert.ok(commit);
		commit.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus[0]?.menuId, MenuId.SCMHistoryItemContext);
		const outside = browser.window.document.createElement('input');
		browser.window.document.body.append(outside);
		outside.focus();
		contextMenus[0].onHide?.(true);
		assert.equal(browser.window.document.activeElement, outside, 'Closing a history menu preserves focus transferred to another input');
		outside.remove();
		assert.equal((contextMenus[0]?.menuActionOptions?.arg as { readonly historyItemViewModel: { readonly historyItem: { readonly id: string; }; }; }).historyItemViewModel.historyItem.id, objectId);
		commit.focus();
		for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
			const event = new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
			commit.dispatchEvent(event);
			assert.equal(event.defaultPrevented, false);
			assert.equal(commit.getAttribute('aria-expanded'), 'false');
		}
		if (isMacintosh) { commit.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true, bubbles: true })); }
		else { commit.click(); }
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
		assert.equal(commit.style.getPropertyValue("--scm-graph-content-x"), "26px");
		assert.ok(commit.querySelector(":scope > .ash-scm-graph-row > .ash-scm-graph-graph"));

		const change = pane.element.querySelector<HTMLButtonElement>(".ash-scm-graph-change");
		change?.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus[1]?.menuId, MenuId.SCMHistoryItemChangeContext);
		assert.deepEqual(contextMenus[1]?.menuActionOptions?.arg && {
			itemId: (contextMenus[1].menuActionOptions.arg as { readonly historyItemViewModel: { readonly historyItem: { readonly id: string; }; }; }).historyItemViewModel.historyItem.id,
			path: (contextMenus[1].menuActionOptions.arg as { readonly historyItemChange: { readonly path: string; }; }).historyItemChange.path,
		}, { itemId: objectId, path: 'src/editor.ts' });
		change?.dispatchEvent(new browser.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
		assert.equal(contextMenus[2]?.menuId, MenuId.SCMHistoryItemChangeContext);
		assert.equal(browser.window.document.activeElement, change);
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
		const openFile = menuService.getMenuActions(MenuId.SCMHistoryItemChangeContext, contextMenus[2].menuActionOptions, contextMenus[2].contextKeyService).flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.openFile')!;
		assert.equal(openFile.enabled, true);
		const inlineOpenFile = change?.parentElement?.querySelector<HTMLButtonElement>('[data-action-id="workbench.scm.action.graph.openFile"] > button');
		assert.ok(inlineOpenFile);
		inlineOpenFile.click();
		await waitFor(() => opened.length === 4);
		assert.equal(commit.getAttribute('aria-expanded'), 'true', 'File actions do not toggle their commit');
		assert.equal(opened[3].input.label, 'editor.ts (1111111)');
		assert.equal(opened[3].input.initialText, 'after\n');
		assert.equal(opened[3].input.readOnly, true);
		change?.focus();
		commit.click();
		assert.equal(commit.getAttribute('aria-expanded'), 'false');
		assert.equal(browser.window.document.activeElement, commit, 'Collapsing a focused child returns focus to its commit');
		assert.ok(!change?.isConnected);
		change?.click();
		assert.equal(opened.length, 4, 'Collapsing files disposes their action listeners');
		commandServices.registerInstance(IViewsService, { getActiveViewWithId: (id: string) => id === 'ash.gitGraph' ? pane : null } as unknown as IViewsService);
		await new CommandService(commandServices).executeCommand('workbench.scm.action.graph.setTreeViewMode');
		assert.equal(historyUiServices.get(IStorageService).get('scm.graphView.viewMode', StorageScope.WORKSPACE), 'tree');
		commit.click();
		await waitFor(() => pane.element.querySelector('.ash-scm-graph-folder') !== null);
		const folder = (): HTMLButtonElement => pane.element.querySelector('.ash-scm-graph-folder')!;
		assert.equal(folder().getAttribute('aria-label'), 'Folder src');
		commit.focus();
		commit.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		assert.equal(browser.window.document.activeElement, folder(), 'Right Arrow enters an expanded commit');
		folder().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		assert.equal(browser.window.document.activeElement?.className, 'ash-scm-graph-change');
		const child = browser.window.document.activeElement!;
		const pageKey = new browser.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
		child.dispatchEvent(pageKey);
		await waitFor(() => browser.window.document.activeElement === commit);
		assert.equal(pageKey.defaultPrevented, true);
		folder().focus();
		folder().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		(browser.window.document.activeElement as HTMLElement).dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		assert.equal(browser.window.document.activeElement, folder());
		folder().click();
		assert.equal(folder().getAttribute('aria-expanded'), 'false');
		assert.equal(pane.element.querySelector<HTMLUListElement>('.ash-scm-graph-folder-children')!.hidden, true);
		folder().dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		assert.equal(folder().getAttribute('aria-expanded'), 'true');
		await new CommandService(commandServices).executeCommand('workbench.scm.action.graph.setListViewMode');
		assert.equal(pane.element.querySelector('.ash-scm-graph-folder'), null);
		binary = true;
		const binaryChange = pane.element.querySelector<HTMLButtonElement>('.ash-scm-graph-change')!;
		binaryChange.click();
		await waitFor(() => opened.length === 5);
		assert.equal(opened[4].input.contentType, 'application/vnd.ash.binary-diff');
		const sides = opened[4].input as IResourceEditorInput & { readonly modified: IResourceEditorInput; };
		assert.deepEqual(sides.modified.initialBytes, new Uint8Array([0, 255]));
		binaryChange.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		const binaryOpen = menuService.getMenuActions(MenuId.SCMHistoryItemChangeContext, contextMenus[3].menuActionOptions, contextMenus[3].contextKeyService).flatMap(([, actions]) => actions).find(action => action.id === 'workbench.scm.action.graph.openFile')!;
		await binaryOpen.run();
		assert.equal(opened.length, 6);
		assert.deepEqual(opened[5].input.initialBytes, new Uint8Array([0, 255]));
		assert.equal(opened[5].input.readOnly, true);
		assert.equal(pane.element.querySelector('[aria-label="history-tag"]'), null, 'Default badges follow the chosen history references');
		await historyConfiguration.updateValue('scm.graph.badges', 'all');
		assert.equal(pane.element.querySelector('[aria-label="history-tag"]')?.getAttribute('aria-label'), 'history-tag');
		await assert.rejects(historyConfiguration.updateValue('scm.graph.badges', 'invalid'));
		await historyConfiguration.updateValue('scm.graph.badges', 'filter');
		assert.equal(pane.element.querySelector('[aria-label="history-tag"]'), null);
		const choosing = new CommandService(commandServices).executeCommand('workbench.scm.action.graph.pickHistoryItemRefs');
		await waitFor(() => browser.window.document.querySelectorAll('[role="option"]').length === 3);
		const all = [...browser.window.document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('All References'))!;
		all.click();
		browser.window.document.querySelector<HTMLInputElement>('.ash-quick-pick-input input')!.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await choosing;
		assert.match(historyUiServices.get(IStorageService).get('scm.graphView.referencesFilter', StorageScope.WORKSPACE)!, /all/);
		pane.dispose();
		change?.click();
		assert.equal(opened.length, 6);
		commit.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		change?.dispatchEvent(new browser.window.MouseEvent("contextmenu", { bubbles: true }));
		assert.equal(contextMenus.length, 4);
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
	} satisfies HistoryFixtureData;
	const { SCMHistoryViewPane } = await import('../../browser/scmHistoryViewPane.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using history = createHistoryViewFixture(git);
		services.registerInstance(ISCMService, history.scmService);
		const hover: IHoverService = { setupDelayedHover: () => testManagedHover(), setupHover: () => testManagedHover(), showHover: () => testManagedHover(), hideHover() { } };
		await import('../../browser/scm.contribution.js');
		using historyConfiguration = new InMemoryConfigurationService();
		using historyUiServices = createTestComponentServices(undefined, undefined, browser.window.document);
		using historyQuickInput = new TestQuickInputService({ container: browser.window.document.body });
		using pane = new SCMHistoryViewPane(browser.window.document.body, { id: 'history-multidiff', title: 'Graph' }, history.viewService, menus, testContextMenuProvider as IContextMenuService, contextKeys, hover, testEditorService(opened), testResourceLabelService(), { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } }, { container: browser.window.document.body, show: () => true, hide() { }, layout() { } }, testHistoryClipboard, testHistoryOpener, historyConfiguration, historyQuickInput, historyUiServices.get(IStorageService), history.scmService);
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
			{ label: 'image.png', before: '', after: '', readOnly: [true, true] },
		]);
		assert.ok(input.items[3].original.resource.path.endsWith('/old.ts'));
		assert.ok(input.items[0].original.resource.path.includes(parentId));
		assert.deepEqual(opened[0].options, { pinned: true });
		assert.equal(input.items[4].binary, true);
		assert.deepEqual(notifications.getNotifications(), []);
		assert.equal(requests.length, 6);
		assert.ok(requests.every(request => request.id === objectId && request.repository === 'repo-1'));
		const historyItem = (await history.viewService.activeRepository!.provider.historyProvider!.provideHistoryItems({ limit: 1 }))![0];
		const context = JSON.parse(JSON.stringify({ repository: { provider: { id: 'repo-1', providerId: 'git' } }, historyItemViewModel: { historyItem }, type: 'historyItemViewModel' }));
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
			contextMenuStyle: 'custom' as const,
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

test('SCM pane focus enters the commit input and restores the focused resource instead of the pane root', async () => {
	using fixture = await createResourceGroupMenuFixture();
	const { pane, tree, browser, key } = fixture;
	pane.focus();
	assert.equal(browser.window.document.activeElement, pane.element.querySelector('.ash-scm-input .stanza-editor-input'));
	tree.focus();
	key('Home');
	const focusedResource = tree.getAttribute('aria-activedescendant');
	assert.ok(focusedResource);
	const outside = browser.window.document.createElement('button');
	browser.window.document.body.append(outside);
	outside.focus();
	pane.focus();
	assert.equal(browser.window.document.activeElement, tree);
	assert.equal(tree.getAttribute('aria-activedescendant'), focusedResource);
});

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
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
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
		retainedFile.focus();
		groups = [{ ...groups[0], resources: [...groups[0].resources, resource('unrelated.ts')] }];
		changes.fire();
		assert.equal(tree.querySelector('[aria-label="Open first.ts"]'), retainedFile, 'Unchanged resource identities retain row DOM across another file update');
		assert.equal(browser.window.document.activeElement, retainedFile, 'An unrelated update preserves keyboard focus on the file action');
		groups = [{ ...groups[0], resources: groups[0].resources.filter(resource => resource.path !== 'unrelated.ts') }];
		changes.fire();
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
		using scm = new SCMService();
		using view = new SCMViewService(scm);
		if (!services.has(ISCMViewService)) services.registerInstance(ISCMViewService, view);
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
	contextMenuStyle: 'custom' as const,
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
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ScmViewPane: ${condition.toString()}`);
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

suite('SCM badge and decorations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
});

// These fixtures describe the generic SCM UI contract. Git policy is exercised by the Rust host tests.
interface GraphQuery { limit: number; cursor?: string; revisions?: readonly string[]; }
interface HistoryFixtureData {
	status(): Promise<{ head: { type: string; name?: string; objectId?: string; }; }>;
	graph(query: GraphQuery): Promise<{ commits: readonly { objectId: string; parentObjectIds: readonly string[]; subject: string; timestampSeconds: number; }[]; references: readonly { name: string; objectId: string; kind: string; }[]; hasMore: boolean; nextCursor?: string; }>;
	commitChanges?(id: string, repository?: string): Promise<{ parentObjectId: string; changes: readonly { path: string; status: string; }[]; }>;
	commitFile?(id: string, path: string, repository?: string): Promise<import('../../common/history.js').ISCMHistoryItemChangeContents | { original: import('../../common/history.js').ISCMHistoryItemContent; modified: import('../../common/history.js').ISCMHistoryItemContent; }>;
	branches(): Promise<readonly unknown[]>;
	onDidBecomeReady?: typeof noEvent; onDidChangeActiveRepository?: typeof noEvent;
}
function historyProviderFixture(overrides: Partial<ISCMHistoryProvider> = {}): ISCMHistoryProvider {
	return {
		onDidChange: Event.None, historyItemRef: observableValue<ISCMHistoryItemRef | undefined>('test.head', undefined), refresh() { },
		provideHistoryItems: async () => [], resolveHistoryItemDetails: async () => { throw new Error('Unexpected details request'); },
		provideHistoryItemChanges: async () => [], resolveHistoryItemChangeContents: async () => { throw new Error('Unexpected contents request'); },
		resolveHistoryItemChatContext: async () => undefined, resolveHistoryItemChangeRangeChatContext: async () => undefined, ...overrides
	};
}
function createHistoryViewFixture(data: HistoryFixtureData) {
	const resources = new DisposableStore();
	const scmService = resources.add(new SCMService());
	const viewService = resources.add(new SCMViewService(scmService));
	const head = observableValue<ISCMHistoryItemRef | undefined>('test.head', undefined);
	let references: ISCMHistoryItemRef[] = [];
	const cursors = new Map<number, string>();
	void data.status().then(status => {
		const ref = { id: status.head.name ?? 'HEAD', name: status.head.name ?? 'HEAD', revision: status.head.objectId };
		references = [ref]; head.set(ref);
	});
	const provider = historyProviderFixture({
		historyItemRef: head,
		provideHistoryItemRefs: async () => references.filter(ref => ref.category !== 'tag'),
		provideHistoryItems: async options => {
			const page = await data.graph({ limit: options.limit ?? 50, ...(options.skip ? { cursor: String(options.skip) } : {}), ...(options.historyItemRefs ? { revisions: options.historyItemRefs } : {}) });
			if (page.nextCursor) cursors.set((options.skip ?? 0) + page.commits.length, page.nextCursor);
			if (page.references.length) references = page.references.map(ref => ({ id: ref.name, name: ref.name, revision: ref.objectId, category: ref.kind === 'tag' ? 'tag' : 'localBranch' }));
			const commits = page.commits.length > (options.limit ?? 50) ? page.commits.slice(options.skip ?? 0, (options.skip ?? 0) + (options.limit ?? 50)) : page.commits;
			return commits.map(commit => ({ id: commit.objectId, parentIds: commit.parentObjectIds, subject: commit.subject, message: commit.subject, displayId: commit.objectId.slice(0, 7), timestamp: commit.timestampSeconds * 1000, references: references.filter(ref => ref.revision === commit.objectId) }));
		},
		provideHistoryItemChanges: async id => {
			const result = await data.commitChanges!(id, "repo-1");
			return result.changes.map(change => ({ ...change, uri: URI.file('/workspace/' + change.path), originalUri: URI.from({ scheme: 'test-history', path: '/' + result.parentObjectId + '/' + ('originalPath' in change && typeof change.originalPath === 'string' ? change.originalPath : change.path) }), modifiedUri: URI.from({ scheme: 'test-history', path: '/' + id + '/' + change.path }), parentId: result.parentObjectId }));
		},
		resolveHistoryItemChangeContents: async (id, change) => ({ ...(await data.commitFile!(id, change.path, "repo-1")), parentId: change.parentId })
	});
	resources.add(scmService.registerSCMProvider(testSCMProvider('repo-1', 'workspace', provider)));
	return Object.assign(resources, { viewService, scmService });
}
