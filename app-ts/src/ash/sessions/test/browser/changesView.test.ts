import '../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event, Emitter } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { observableValue } from '../../../base/common/observable.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { createDisconnectedRendererApi } from '../../../platform/app-server/browser/rendererApi.js';
import type { TurnChangesReadResult } from '../../../platform/app-server/common/generated/index.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { ChatService } from '../../../workbench/services/chat/browser/chatService.js';
import { IChatService } from '../../../workbench/services/chat/common/chatService.js';
import { IEditorService, type EditorInput, type EditorOpenOptions } from '../../../workbench/services/editor/common/editorService.js';
import { isDiffEditorInput } from '../../../workbench/common/editor/diffEditorInput.js';
import { isMultiDiffEditorInput } from '../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { ISessionsService, type SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import { ChangesViewPane } from '../../contrib/changes/browser/changesView.js';
import { createTurnMultiDiffEditorInput } from '../../browser/turnMultiDiffSource.js';

test('Changes ignores an old conversation response and opens a shared read-only Diff from the selected row', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://changes.test' });
	try {
		using services = new InstantiationService();
		using changed = new Emitter<void>();
		using config = new WorkbenchConfigurationService();
		using contexts = new ContextKeyService();
		using notifications = new NotificationService();
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'changes', workspaceId: 'sessions', flushInterval: 0 });
		let selection = selected('old');
		const sessions: ISessionsService = {
			onDidChange: changed.event, page: observableValue('page', 'code' as const),
			get activeSelection() { return selection; }, get visibleSelections() { return [selection]; },
			canNavigateBack: false, canNavigateForward: false,
			selectPage() {}, getPageSelection() { return { activeSelection: selection, visibleSelections: [selection] }; },
			async initialize() {}, async openThread() {}, openSession() {}, openUntitledSession() {},
			openNewSession(): never { throw new Error('This test selects durable conversations'); },
			activateSelection() {}, closeVisibleSelection() {}, navigateBack() {}, navigateForward() {},
		};
		const old = new DeferredPromise<{ changeSets: TurnChangesReadResult['summary'][] }>();
		const details = changes('current');
		const requests: unknown[] = [];
		const host = createDisconnectedRendererApi();
		let truncated = false;
		using chat = new ChatService({ modelApi: host.model, threadApi: host.thread, turnApi: host.turn, skillApi: host.skills, appServerApi: host.appServer, eventApi: host.events,
			turnChangesApi: { ...host.turnChanges,
				list: async params => params.sessionId === 'old' ? old.p : { changeSets: [details.summary] },
				read: async params => { requests.push(params); return details; },
				readFile: async params => { requests.push(params); return { path: 'main.ts', binary: false, truncated, before: 'before', after: 'after' }; },
			},
		});
		const opened: EditorInput[] = [];
		const openOptions: (EditorOpenOptions | undefined)[] = [];
		const editors: IEditorService = { onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], async openEditor(input, options) { opened.push(input); openOptions.push(options); }, focusActiveEditor() {} };
		services.registerInstance(ISessionsService, sessions);
		services.registerInstance(IChatService, chat);
		services.registerInstance(IEditorService, editors);
		services.registerInstance(IConfigurationService, config);
		services.registerInstance(IContextKeyService, contexts);
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.', dispose() {}, [Symbol.dispose]() {} });
		using view = services.createInstance(ChangesViewPane, browser.window.document.body, { id: 'changes', title: 'Changes' });
		view.setVisible(true);
		selection = selected('current');
		changed.fire();
		await settle();
		await old.complete({ changeSets: [] });
		await settle();
		assert.match(view.getAccessibleContent(), /1 changed files\nmain.ts: \+1 −1/u);
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
		assert.match(notifications.getNotifications()[0]!.message, /too large/u);
		assert.equal(selection.kind, 'session');
		if (selection.kind === 'session') await assert.rejects(createTurnMultiDiffEditorInput(chat, selection.active, 'currentTurn'), /too large/u);
	} finally { browser.window.close(); }
});

function selected(id: string): SessionsViewSelection {
	return { kind: 'session', active: { threadId: `${id}-thread`, session: { sessionId: id, title: id, status: 'active', nextApprovalMode: 'askPermissions', chats: [] } } };
}

function changes(id: string): TurnChangesReadResult {
	return { summary: { changeSetId: `change-${id}`, sessionId: id, threadId: `${id}-thread`, turnId: 'turn', repositoryId: 'repo', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 }, files: [{ path: 'main.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }] };
}

async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
