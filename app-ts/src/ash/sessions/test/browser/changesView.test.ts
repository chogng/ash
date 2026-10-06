import type { IResourceEditorInput } from '../../../workbench/common/editor.js';
import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event, Emitter } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { createDisconnectedRendererApi } from '../../../platform/app-server/browser/rendererApi.js';
import type { TurnChangesReadResult } from '../../../platform/app-server/common/generated/index.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { ChatService } from '../../../workbench/services/chat/browser/chatService.js';
import { IChatService } from '../../../workbench/services/chat/common/chatService.js';
import { IEditorService, type EditorOpenOptions } from '../../../workbench/services/editor/common/editorService.js';
import { isDiffEditorInput } from '../../../workbench/common/editor/diffEditorInput.js';
import { isMultiDiffEditorInput } from '../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { ISessionsService, type SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import { ChangesViewPane } from '../../contrib/changes/browser/changesView.js';
import { setNlsMessages, resetNlsResolver } from '../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { createTurnMultiDiffEditorInput } from '../../browser/turnMultiDiffSource.js';

for (const locale of ['en', 'zh-CN']) test(`Changes preserves file selection and immutable review across refresh and ownership changes (${locale})`, async () => {
	setNlsMessages(locale, builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles);
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
	try {
		using services = new InstantiationService();
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
		let pendingRead: DeferredPromise<{ path: string; binary: boolean; truncated: boolean; before: string; after: string; }> | undefined;
		using chat = new ChatService({
			modelApi: host.model, threadApi: host.thread, turnApi: host.turn, skillApi: host.skills, appServerApi: host.appServer, eventApi: host.events,
			turnChangesApi: {
				...host.turnChanges,
				list: async params => params.sessionId === 'old' ? old.p : { changeSets: [details.summary] },
				read: async params => { requests.push(params); return details; },
				readFile: async params => { requests.push(params); return pendingRead ? pendingRead.p : { path: 'main.ts', binary: false, truncated, before: 'before', after: 'after' }; },
			},
		});
		const opened: IResourceEditorInput[] = [];
		const openOptions: (EditorOpenOptions | undefined)[] = [];
		const editors: IEditorService = { onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], async openEditor(input, options) { opened.push(input); openOptions.push(options); }, focusActiveEditor() { } };
		services.registerInstance(IQuickInputService, { input: async () => 'feat: reviewed selection', createQuickPick() { throw new Error('This scenario uses a message input'); } });
		services.registerInstance(ISessionsService, sessions);
		services.registerInstance(IChatService, chat);
		services.registerInstance(IEditorService, editors);
		services.registerInstance(IConfigurationService, config);
		services.registerInstance(IContextKeyService, contexts);
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.', disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
		using view = services.createInstance(ChangesViewPane, browser.window.document.body, { id: 'changes', title: 'Changes' });
		view.setVisible(true);
		selection = selected('current');
		changed.fire();
		await settle();
		await old.complete({ changeSets: [] });
		await settle();
		assert.match(view.getAccessibleContent(), /main.ts: \+1 −1/u);
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
		assert.deepEqual([diff.original.initialText, diff.modified.initialText, diff.original.readOnly, diff.modified.readOnly], ['before', 'after', true, true]);
		assert.deepEqual(requests.at(-1), { sessionId: 'current', threadId: 'current-thread', changeSetId: 'change-current', path: 'main.ts' });
		view.element.querySelector<HTMLButtonElement>('.ash-sessions-changes button')!.click();
		await settle();
		assert.equal(opened.length, 3);
		const review = opened[2]!;
		assert.ok(isMultiDiffEditorInput(review));
		assert.deepEqual(review.items.map(item => [item.original.initialText, item.modified.initialText, item.original.readOnly, item.modified.readOnly]), [['before', 'after', true, true]]);
		truncated = true;
		tree.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		assert.equal(opened.length, 3);
		assert.match(notifications.getNotifications()[0]!.message, locale === 'zh-CN' ? /过大/u : /too large/u);
		assert.equal(selection.kind, 'session');
		if (selection.kind === 'session') await assert.rejects(createTurnMultiDiffEditorInput(chat, selection.active, 'currentTurn'), locale === 'zh-CN' ? /过大/u : /too large/u);
		view.element.querySelector<HTMLElement>('[role=treeitem]')!.click();
		assert.equal(preview.disabled, false);
		changed.fire();
		await settle();
		assert.equal(preview.disabled, false);
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
	return { kind: 'session', active: { threadId: `${id}-thread`, session: { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', chats: [] } } };
}

function changes(id: string): TurnChangesReadResult {
	return { summary: { changeSetId: `change-${id}`, sessionId: id, threadId: `${id}-thread`, turnId: 'turn', repositoryId: 'repo', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 }, files: [{ path: 'main.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }] };
}

async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
