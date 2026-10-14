import { IChangesViewService } from '../../contrib/changes/common/changesViewService.js';
import { ChangesViewService } from '../../contrib/changes/browser/changesViewService.js';
import { ISessionChangesService } from '../../contrib/changes/common/sessionChangesService.js';
import { SessionChangesService } from '../../contrib/changes/browser/sessionChangesService.js';
import { SessionChangesEditorInput } from '../../contrib/changes/browser/sessionChangesEditorInput.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IDecorationsService } from '../../../workbench/services/decorations/common/decorations.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { emptyEditorServiceState } from '../../../workbench/test/common/testEditorService.js';
import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import type { IResourceEditorInput } from '../../../workbench/common/editor.js';
import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event, Emitter } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { registerTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { createDisconnectedRendererApi } from '../../../platform/agentHost/browser/rendererApi.js';
import type { TurnChangesReadResult } from '../../../../../.build/protocol/typescript/index.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { IAgentThreadService, IAgentTurnService } from '../../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../../platform/agentHost/common/agentModels.js';
import { IAppServerApi, IServerEventApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../../platform/agentHost/common/appServerApi.js';
import { ITurnChangesApi } from '../../../platform/turnChanges/common/turnChangesApi.js';
import { ChatService } from '../../../workbench/services/chat/browser/chatService.js';
import { IChatService } from '../../../workbench/services/chat/common/chatService.js';
import { IEditorService, type EditorOpenOptions } from '../../../workbench/services/editor/common/editorService.js';
import { isDiffEditorInput } from '../../../workbench/common/editor/diffEditorInput.js';
import { ISessionsService, type SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import { ChangesViewPane } from '../../contrib/changes/browser/changesView.js';
import { setNlsMessages, resetNlsResolver } from '../../../nls.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { createTurnCommitPreviewInput, createTurnMultiDiffEditorInput } from '../../browser/turnMultiDiffSource.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { CHANGES_VIEW_ID } from '../../contrib/changes/common/changes.js';
import '../../contrib/changes/browser/changes.contribution.js';
import { IGitHubService as ISessionGitHubService } from '../../contrib/github/browser/githubService.js';
import { IGitHubService as IGitHubApi } from '../../../platform/github/common/githubService.js';
import { IAccountService } from '../../../platform/accounts/common/accountService.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';

for (const locale of ['en', 'zh-CN']) test(`Changes preserves file selection and immutable review across refresh and ownership changes (${locale})`, async () => {
	setNlsMessages(locale, productLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles);
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
	try {
		using services = new InstantiationService();
		registerChecksServices(services);
		services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
		services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
		using changed = new Emitter<void>();
		using config = new WorkbenchConfigurationService();
		using contexts = new ContextKeyService();
		using notifications = new NotificationService();
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
		let selection = selected('old');
		const sessions: ISessionsService = {
			onDidChange: changed.event, get activeSelection() { return selection; }, get visibleSelections() { return [selection]; },
			canNavigateBack: false, canNavigateForward: false,
			getSelection() { return { activeSelection: selection, visibleSelections: [selection] }; },
			async initialize() { }, async openThread() { }, openSession() { }, openUntitledSession() { },
			openNewSession(): never { throw new Error('This test selects durable conversations'); },
			activateSelection() { }, closeVisibleSelection() { }, navigateBack() { }, navigateForward() { },
		};
		const old = new DeferredPromise<{ changeSets: TurnChangesReadResult['summary'][]; }>();
		const details = changes('current');
		const requests: unknown[] = [];
		const host = createDisconnectedRendererApi();
		let truncated = false;
		let loadFailure = false;
		let pendingRefresh: DeferredPromise<{ changeSets: TurnChangesReadResult['summary'][]; }> | undefined;
		let pendingRead: DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }> | undefined;
		services.registerInstance(IAgentModelsService, host.model);
		services.registerInstance(IAgentThreadService, host.thread);
		services.registerInstance(IAgentTurnService, host.turn);
		services.registerInstance(IAppServerSkillApi, host.skills);
		services.registerInstance(IAppServerApi, host.appServer);
		services.registerInstance(IServerEventApi, host.events);
		services.registerInstance(ITurnChangesApi, {
			...host.turnChanges,
			list: async params => {
				if (loadFailure) { throw new Error('Repository unavailable'); }
				return params.sessionId === 'old' ? old.p : pendingRefresh ? pendingRefresh.p : { changeSets: [details.summary] };
			},
			read: async params => { requests.push(params); return details; },
			readFile: async params => { requests.push(params); return pendingRead ? pendingRead.p : { path: 'main.ts', binary: false, truncated, before: 'before', after: 'after' }; },
		});
		using chat = services.createInstance(ChatService);
		const opened: IResourceEditorInput[] = [];
		const openOptions: (EditorOpenOptions | undefined)[] = [];
		const editors: IEditorService = { ...emptyEditorServiceState, onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], async openEditor(input, options) { opened.push(input); openOptions.push(options); }, focusActiveEditor() { } };
		services.registerInstance(IQuickInputService, { input: async () => 'feat: reviewed selection', createQuickPick() { throw new Error('This scenario uses a message input'); } } as unknown as IQuickInputService);
		services.registerInstance(ISessionsService, sessions);
		services.registerInstance(IChatService, chat);
		services.registerInstance(IEditorService, editors);
		services.registerInstance(IConfigurationService, config);
		services.registerInstance(IContextKeyService, contexts);
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.', disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
		services.registerInstance(IStorageService, storage);
		services.registerSingleton(IChangesViewService, () => services.createInstance(ChangesViewService));
		using view = services.createInstance(ChangesViewPane, browser.window.document.body, { id: 'changes', title: 'Changes' });
		services.registerInstance(IViewsService, { getViewWithId: (id: string) => id === CHANGES_VIEW_ID ? view : undefined } as unknown as IViewsService);
		view.setVisible(true);
		selection = selected('current');
		changed.fire();
		await settle();
		await old.complete({ changeSets: [] });
		await settle();
		assert.match(view.getAccessibleContent(), /main.ts: \+1 −1/u);
		assert.equal(view.element.querySelector('.ash-sessions-changes-summary')!.textContent, locale === 'zh-CN' ? '1 项文件更改 · +1 −1' : '1 file changes · +1 −1');
		const accessibility = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('sessionsChanges.'));
		for (const implementation of accessibility) {
			using provider = implementation.getProvider(services)!;
			if (implementation.type === AccessibleViewType.View) {
				assert.equal(provider.provideContent(), view.getAccessibleContent());
			} else {
				assert.match(provider.provideContent(), locale === 'zh-CN' ? /方向键/u : /arrow keys/u);
			}
		}
		const preview = view.element.querySelectorAll<HTMLButtonElement>('.ash-sessions-changes button')[1]!;
		assert.equal(preview.textContent, locale === 'zh-CN' ? '预览选中的更改' : 'Preview selected changes');
		const tree = view.element.querySelector<HTMLElement>('[role="tree"]')!;
		assert.equal(tree.getAttribute('aria-description'), 'Press Alt+F1 for accessibility help.');
		view.focus();
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await settle();
		assert.equal(opened.length, 1);
		assert.deepEqual(openOptions[0], { pinned: false, preserveFocus: true });
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		assert.equal(opened.length, 2);
		assert.deepEqual(openOptions[1], { pinned: true, preserveFocus: false });
		const diff = opened[0]!;
		assert.ok(isDiffEditorInput(diff));
		assert.deepEqual(Object.fromEntries(new URLSearchParams(diff.original.resource.query)), { session: 'current', thread: 'current-thread', revision: '1', side: 'before' });
		assert.equal(new URLSearchParams(diff.modified.resource.query).get('side'), 'after');
		assert.deepEqual([diff.original.initialText, diff.modified.initialText, diff.original.readOnly, diff.modified.readOnly], ['before', 'after', true, true]);
		assert.deepEqual(requests.find(request => typeof request === 'object' && request !== null && 'path' in request), { sessionId: 'current', threadId: 'current-thread', changeSetId: 'change-current', path: 'main.ts' });
		const turnPicker = view.element.querySelector<HTMLSelectElement>('select')!;
		turnPicker.value = 'change-current';
		turnPicker.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
		view.element.querySelector<HTMLButtonElement>('.ash-sessions-changes button')!.click();
		await settle();
		assert.equal(opened.length, 3);
		const review = opened[2]!;
		assert.ok(review instanceof SessionChangesEditorInput);
		assert.equal(review.resource.toString(), 'ash-session-changes:/current?thread=current-thread');
		assert.deepEqual(review.changesetSelection, { kind: 'id', id: 'change-current' });
		assert.equal(openOptions[2]?.forceReload, true);
		turnPicker.value = '';
		turnPicker.dispatchEvent(new browser.window.Event('change', { bubbles: true }));
		truncated = true;
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		assert.equal(opened.length, 3);
		assert.match(notifications.getNotifications()[0]!.message, locale === 'zh-CN' ? /过大/u : /too large/u);
		assert.equal(selection.kind, 'session');
		if (selection.kind === 'session') await assert.rejects(createTurnMultiDiffEditorInput(chat, selection.active, 'currentTurn'), locale === 'zh-CN' ? /过大/u : /too large/u);
		view.element.querySelector<HTMLElement>('[role=treeitem]')!.click();
		assert.equal(preview.disabled, false);
		pendingRefresh = new DeferredPromise();
		changed.fire();
		assert.equal(preview.disabled, true);
		assert.equal(tree.getAttribute('aria-busy'), 'true');
		assert.equal(view.element.querySelectorAll('[role=treeitem]').length, 1);
		await pendingRefresh.complete({ changeSets: [details.summary] });
		await settle();
		pendingRefresh = undefined;
		assert.equal(preview.disabled, false);
		assert.equal(tree.hasAttribute('aria-busy'), false);
		loadFailure = true;
		changed.fire();
		await settle();
		assert.equal(preview.disabled, true);
		assert.equal(view.element.querySelectorAll('[role=treeitem]').length, 0);
		assert.match(view.getAccessibleContent(), /Repository unavailable/u);
		const retry = view.element.querySelectorAll<HTMLButtonElement>('.ash-sessions-changes button')[2]!;
		assert.equal(retry.hidden, false);
		assert.equal(retry.textContent, locale === 'zh-CN' ? '重新加载更改' : 'Retry loading changes');
		loadFailure = false;
		retry.click();
		await settle();
		assert.equal(retry.hidden, true);
		assert.equal(view.element.querySelectorAll('[role=treeitem]').length, 1);
		details.summary.commitState = 'conflict';
		changed.fire();
		await settle();
		assert.match(view.getAccessibleContent(), locale === 'zh-CN' ? /存在冲突/u : /Conflict/u);
		details.summary.committedPaths = ['main.ts'];
		details.summary.commitState = 'committed';
		changed.fire();
		await settle();
		assert.equal(preview.disabled, true);
		assert.match(view.getAccessibleContent(), locale === 'zh-CN' ? /已提交/u : /Committed/u);
		pendingRead = new DeferredPromise();
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		selection = selected('other');
		changed.fire();
		await settle();
		await pendingRead.complete({ path: 'main.ts', binary: false, truncated: false, before: 'before', after: 'after' });
		await settle();
		assert.equal(opened.length, 3);
		assert.equal(preview.disabled, true);
	} finally { resetNlsResolver(); browser.window.close(); }
});

function selected(id: string): SessionsViewSelection {
	return { kind: 'session', active: { threadId: `${id}-thread`, session: { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: `${id}-thread`, status: 'active', origin: { type: 'root' } }] } } };
}

function registerChecksServices(services: InstantiationService): void {
	services.registerSingleton(ISessionChangesService, () => services.createInstance(SessionChangesService));
	services.registerInstance(ISessionsManagementService, {
		get sessions() {
			const selection = services.get(ISessionsService).activeSelection;
			return selection?.kind === 'session' ? [selection.active.session] : [];
		},
	} as unknown as ISessionsManagementService);
	services.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
	services.registerInstance(IDecorationsService, { registerDecorationsProvider: () => toDisposable(() => { }) } as unknown as IDecorationsService);
	services.registerInstance(ICommandService, { executeCommand: async () => [] } as unknown as ICommandService);
	services.registerInstance(ISessionGitHubService, { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as ISessionGitHubService);
	services.registerInstance(IGitHubApi, {} as IGitHubApi);
	services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None } as unknown as IAccountService);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
}

function changes(id: string): TurnChangesReadResult {
	return { summary: { changeSetId: `change-${id}`, sessionId: id, threadId: `${id}-thread`, turnId: 'turn', repositoryId: 'repo', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 }, files: [{ path: 'main.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }] };
}

async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

test('Turn comparison cancellation finishes before the in-flight read and prevents later reads', async () => {
	const details = changes('session');
	details.files.push({ ...details.files[0]!, path: 'next.ts' });
	const pending = new DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }>();
	const reads: string[] = [];
	const chat = {
		listTurnChanges: async () => [details.summary],
		readTurnChange: async () => { reads.push('capture'); return details; },
		readTurnChangeFile: (_session: string, _thread: string, _capture: string, path: string) => { reads.push(path); return pending.p; },
	} as unknown as IChatService;
	const selection = selected('session');
	if (selection.kind !== 'session') { throw new Error('Expected a durable conversation'); }
	const controller = new AbortController();
	const comparison = createTurnMultiDiffEditorInput(chat, selection.active, 'currentTurn', undefined, controller.signal);
	const rejected = assert.rejects(comparison, { name: 'CancellationError' });
	await settle();
	controller.abort();
	await rejected;
	await pending.complete({ path: 'main.ts', binary: false, truncated: false, before: 'before', after: 'after' });
	await settle();
	assert.deepEqual(reads, ['capture', 'main.ts']);
	await assert.rejects(createTurnMultiDiffEditorInput(chat, selection.active, 'currentTurn', undefined, controller.signal), { name: 'CancellationError' });
	assert.deepEqual(reads, ['capture', 'main.ts']);
});

test('Turn comparisons reject a capture revised or discarded while its file contents load', async () => {
	for (const discarded of [false, true]) {
		let current = changes('session');
		const pending = new DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }>();
		const chat = {
			listTurnChanges: async () => [current.summary],
			readTurnChange: async () => current,
			readTurnChangeFile: () => pending.p,
		} as unknown as IChatService;
		const selection = selected('session');
		assert.equal(selection.kind, 'session');
		if (selection.kind !== 'session') { throw new Error('Expected a durable conversation'); }
		const comparison = createTurnMultiDiffEditorInput(chat, selection.active, 'currentTurn');
		const rejected = assert.rejects(comparison, /Turn capture changed while loading/u);
		await settle();
		current = { ...current, summary: { ...current.summary, revision: discarded ? 1 : 2, captureState: discarded ? 'discarded' : 'sealed' } };
		await pending.complete({ path: 'main.ts', binary: false, truncated: false, before: 'old', after: 'new revision' });
		await rejected;
	}
});

suite('Changes visibility lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const revision of [1, 2, 3]) test(`a pending file comparison survives only an unchanged capture revision (${revision === 3 ? 'changed before notification' : revision})`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		using browserOwner = toDisposable(() => browser.window.close());
		using services = new InstantiationService();
		registerChecksServices(services);
		using changed = new Emitter<void>();
		using ledgerChanged = new Emitter<{ sessionId: string; threadId: string; }>();
		using configuration = new WorkbenchConfigurationService();
		using contexts = new ContextKeyService();
		using notifications = new NotificationService();
		const pendingFile = new DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }>();
		const opened: IResourceEditorInput[] = [];
		using openedOwner = toDisposable(() => {
			for (const input of opened) {
				if (isDiffEditorInput(input)) { input.dispose(); }
			}
		});
		let details = changes('a');
		let reads = 0;
		services.registerInstance(ISessionsService, {
			onDidChange: changed.event, activeSelection: selected('a'),
		} as unknown as ISessionsService);
		services.registerInstance(IChatService, {
			onDidUpdateTurnChanges: ledgerChanged.event,
			onDidBecomeReady: Event.None,
			listTurnChanges: async () => [details.summary],
			readTurnChange: async () => details,
			readTurnChangeFile: async () => { reads++; return pendingFile.p; },
		} as unknown as IChatService);
		services.registerInstance(IEditorService, {
			...emptyEditorServiceState, openEditor: async (input: IResourceEditorInput) => { opened.push(input); },
		} as unknown as IEditorService);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IContextKeyService, contexts);
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(IQuickInputService, { input: async () => undefined } as unknown as IQuickInputService);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerSingleton(IChangesViewService, () => services.createInstance(ChangesViewService));
		using view = registerTestComponentServices(services).createInstance(ChangesViewPane, browser.window.document.body, { id: CHANGES_VIEW_ID, title: 'Changes' });
		view.setVisible(true);
		await settle();
		const tree = view.element.querySelector<HTMLElement>('[role="tree"]')!;
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await settle();
		assert.equal(reads, 1);
		details = { ...details, summary: { ...details.summary, revision: revision === 1 ? 1 : 2 } };
		if (revision !== 3) { ledgerChanged.fire({ sessionId: 'a', threadId: 'a-thread' }); }
		await settle();
		await pendingFile.complete({ path: 'main.ts', binary: false, truncated: false, before: 'before', after: 'after' });
		await settle();
		assert.equal(opened.length, revision === 1 ? 1 : 0);
		if (revision === 3) { assert.match(notifications.getNotifications()[0]!.message, /Turn capture changed/u); }
	});

	test('hidden views stop ledger reads, ignore late operations and restore live accessibility content', async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		using browserOwner = toDisposable(() => browser.window.close());
		using services = new InstantiationService();
		registerChecksServices(services);
		using changed = new Emitter<void>();
		using ready = new Emitter<void>();
		using ledgerChanged = new Emitter<{ sessionId: string; threadId: string; }>();
		using configuration = new WorkbenchConfigurationService();
		using contexts = new ContextKeyService();
		using notifications = new NotificationService();
		let selection = selected('a');
		const pendingList = new DeferredPromise<readonly TurnChangesReadResult['summary'][]>();
		const pendingFile = new DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }>();
		const pendingMessage = new DeferredPromise<string>();
		const listCalls: string[] = [];
		const detailReads: string[] = [];
		const opened: IResourceEditorInput[] = [];
		let fileRead = false;
		let prepares = 0;
		services.registerInstance(ISessionsService, {
			onDidChange: changed.event,
			get activeSelection() { return selection; },
		} as unknown as ISessionsService);
		services.registerInstance(IChatService, {
			onDidUpdateTurnChanges: ledgerChanged.event,
			onDidBecomeReady: ready.event,
			listTurnChanges: async (sessionId: string) => {
				listCalls.push(sessionId);
				return listCalls.length === 1 ? pendingList.p : [changes(sessionId).summary];
			},
			readTurnChange: async (sessionId: string) => {
				detailReads.push(sessionId);
				return changes(sessionId);
			},
			readTurnChangeFile: async () => { fileRead = true; return pendingFile.p; },
			prepareTurnCommit: async () => { prepares++; throw new Error('A stale preview must not reach the backend'); },
		} as unknown as IChatService);
		services.registerInstance(IEditorService, {
			...emptyEditorServiceState,
			openEditor: async (input: IResourceEditorInput) => { opened.push(input); },
		} as unknown as IEditorService);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IContextKeyService, contexts);
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(IQuickInputService, { input: async () => pendingMessage.p } as unknown as IQuickInputService);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerSingleton(IChangesViewService, () => services.createInstance(ChangesViewService));
		using view = registerTestComponentServices(services).createInstance(ChangesViewPane, browser.window.document.body, { id: CHANGES_VIEW_ID, title: 'Changes' });
		services.registerInstance(IViewsService, { getViewWithId: (id: string) => id === CHANGES_VIEW_ID ? view : undefined } as unknown as IViewsService);

		changed.fire();
		ready.fire();
		assert.deepEqual(listCalls, []);
		view.setVisible(true);
		assert.deepEqual(listCalls, ['a']);
		view.setVisible(false);
		selection = selected('b');
		changed.fire();
		ready.fire();
		ledgerChanged.fire({ sessionId: 'b', threadId: 'b-thread' });
		await pendingList.complete([changes('a').summary]);
		await settle();
		assert.deepEqual({ listCalls, detailReads }, { listCalls: ['a'], detailReads: [] });
		view.setVisible(true);
		await settle();
		assert.deepEqual({ listCalls, detailReads }, { listCalls: ['a', 'b'], detailReads: ['b'] });
		view.setVisible(true);
		assert.equal(listCalls.length, 2);
		assert.match(view.getAccessibleContent(), /main.ts/u);

		const tree = view.element.querySelector<HTMLElement>('[role="tree"]')!;
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await settle();
		assert.equal(fileRead, true);
		view.setVisible(false);
		view.setVisible(true);
		await settle();
		await pendingFile.complete({ path: 'main.ts', binary: false, truncated: false, before: 'before', after: 'after' });
		await settle();
		assert.deepEqual(opened, []);

		view.element.querySelector<HTMLElement>('[role="treeitem"]')!.click();
		await settle();
		const preview = view.element.querySelectorAll<HTMLButtonElement>('.ash-sessions-changes button')[1]!;
		assert.equal(preview.disabled, false);
		preview.click();
		await settle();
		selection = selected('c');
		changed.fire();
		selection = selected('b');
		changed.fire();
		await settle();
		await pendingMessage.complete('feat: stale preview');
		await settle();
		assert.equal(prepares, 0);

		const providers = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('sessionsChanges.'));
		assert.equal(providers.length, 2);
		for (const implementation of providers) {
			using provider = implementation.getProvider(services)!;
			assert.ok(provider);
			if (implementation.type === AccessibleViewType.View) {
				assert.equal(provider.provideContent(), view.getAccessibleContent());
			} else {
				assert.match(provider.provideContent(), /arrow keys/u);
			}
			provider.dispose();
			assert.equal(browser.window.document.activeElement, tree);
		}
		view.dispose();
		assert.equal(ready.hasListeners(), false);
		assert.equal(ledgerChanged.hasListeners(), false);
		// Window-owned view snapshots outlive a pane; their selection subscription
		// is released with the window service scope rather than with this view.
		services.dispose();
		assert.equal(changed.hasListeners(), false);
	});
});


test('Turn review and commit preview retain binary-only files without text placeholders', async () => {
	const details = changes('session');
	const summary = details.summary;
	const file = { ...details.files[0], path: 'image.bin', binary: true };
	const chat = {
		listTurnChanges: async () => [summary],
		readTurnChange: async () => ({ summary, files: [file] }),
		readTurnChangeFile: async () => ({ path: file.path, binary: true, truncated: false, before: undefined, after: undefined }),
		readTurnCommitFile: async () => ({ path: file.path, binary: true, truncated: false, before: undefined, after: undefined }),
	} as unknown as IChatService;
	const review = await createTurnMultiDiffEditorInput(chat, { session: { sessionId: 'session' }, threadId: 'thread' } as never, 'currentTurn');
	const preview = await createTurnCommitPreviewInput(chat, 'session', 'thread', { commitId: 'commit', targetBranch: 'main', message: 'Binary changes', files: [file], warnings: [] } as never);
	for (const input of [review, preview]) {
		assert.deepEqual(input.items.map(item => ({ binary: item.binary, before: item.original.initialText, after: item.modified.initialText })), [{ binary: true, before: '', after: '' }]);
		assert.equal(input.readOnly, true);
	}
});
