import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IActionListItem, IActionListDelegate } from '../../../../../platform/actionWidget/browser/actionList.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { IQuickInputService, type IInputOptions } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService, type IRecent } from '../../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IChatWidgetModel } from '../../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISession, IUntitledChatSession, SessionExecutionTarget, SessionWorkspaceSelection } from '../../../../services/sessions/common/session.js';
import { SessionWorkspacePicker } from '../../browser/sessionWorkspacePicker.js';

function fixture(target: SessionExecutionTarget = { type: 'local', root: URI.file('/project').fsPath }, catalog: readonly ISession[] = []) {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	lifetime.add(setARIAContainer(dom.window.document.body));
	const services = lifetime.add(new InstantiationService());
	const changed = lifetime.add(new Emitter<void>());
	const updated = lifetime.add(new Emitter<void>());
	const loaded = lifetime.add(new Emitter<void>());
	const dialog = new DeferredPromise<readonly URI[] | undefined>();
	const branch = new DeferredPromise<string | undefined>();
	let inputOptions: IInputOptions | undefined;
	let drafts: readonly IUntitledChatSession[] = ['first', 'second'].map(id => ({
		untitledSessionId: id, title: id, providerId: 'host', model: undefined, agent: undefined, workspace: target,
	}));
	let items: readonly IActionListItem<IAction>[] = [];
	let delegate: IActionListDelegate<IAction> | undefined;
	let disposed = false;
	services.registerInstance(IActionWidgetService, {
		show: (_user: string, _preview: boolean, choices: typeof items, callbacks: IActionListDelegate<IAction>) => {
			items = choices;
			delegate = callbacks;
		},
		updateItems: (choices: typeof items) => { items = choices; loaded.fire(); },
		hide: () => { disposed = true; delegate = undefined; },
	} as unknown as IActionWidgetService);
	const model = { untitledSessionId: 'first', inputState: { phase: 'ready' }, onDidChange: updated.event };
	const errors: unknown[] = [];
	services.registerInstance(INotificationService, { error: (error: unknown) => { errors.push(error); } } as unknown as INotificationService);
	services.registerInstance(ISessionsManagementService, {
		get untitledSessions() { return drafts; }, sessions: catalog, onDidChange: changed.event,
		setUntitledSessionWorkspace(id: string, workspace: SessionWorkspaceSelection, options?: Parameters<ISessionsManagementService['setUntitledSessionWorkspace']>[2]) {
			drafts = drafts.map(draft => draft.untitledSessionId === id ? { ...draft, workspace, ...options } : draft);
			changed.fire();
		},
	} as unknown as ISessionsManagementService);
	services.registerInstance(ISessionsProvidersService, {
		getProvider: () => ({
			isDevContainerWorkspaceAvailable: async () => false,
			getWorktrees: async () => [{ label: 'review', target: { ...target, root: '/checkouts/review' } }],
		}),
	} as unknown as ISessionsProvidersService);
	services.registerInstance(IWorkspaceContextService, {
		getWorkspace: () => ({ id: 'project', folders: [] }), onDidChangeWorkspaceFolders: Event.None,
	} as unknown as IWorkspaceContextService);
	let history: readonly IRecent[] = [{ folderUri: URI.file('/recent'), label: 'Recent project' }];
	services.registerInstance(IWorkspacesService, {
		getRecentlyOpened: async () => ({ workspaces: history }),
		addRecentlyOpened: async (entries: readonly IRecent[]) => { history = [...entries, ...history]; },
	} as unknown as IWorkspacesService);
	services.registerInstance(IFileDialogService, { showOpenDialog: () => dialog.p } as unknown as IFileDialogService);
	services.registerInstance(IQuickInputService, {
		input: (options: IInputOptions) => { inputOptions = options; return branch.p; },
	} as unknown as IQuickInputService);
	const control = lifetime.add(services.createInstance(SessionWorkspacePicker, dom.window.document.body, model as unknown as IChatWidgetModel));
	const button = dom.window.document.querySelector('button')!;
	return {
		button, control, model, changed, updated, dialog, branch, errors,
		get labels() { return items.map(item => item.label); }, get drafts() { return drafts; }, get inputOptions() { return inputOptions; }, get disposed() { return disposed; },
		async open() {
			button.click();
			await new Promise<void>(resolve => lifetime.add(Event.once(loaded.event)(resolve)));
		},
		choose(label: string) {
			const action = items.find(item => item.label === label)?.item;
			assert.ok(action && delegate, `Missing choice: ${label}`);
			void delegate.onSelect(action);
		},
		[Symbol.dispose]() { lifetime.dispose(); },
	};
}

test('Workspace picks an existing worktree for only its owning independent conversation', async () => {
	using f = fixture();
	await f.open();
	f.choose('Worktree · review');
	assert.equal(f.drafts[0]?.workspace.type, 'local');
	assert.equal((f.drafts[0]?.workspace as SessionExecutionTarget).root, '/checkouts/review');
	assert.equal((f.drafts[1]?.workspace as SessionExecutionTarget).root, URI.file('/project').fsPath);
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	assert.equal(f.button.ownerDocument.activeElement, f.button);
	assert.deepEqual(f.errors, []);
});

test('Recent folders are selectable in the first menu before Open Folder', async () => {
	using f = fixture();
	await f.open();
	assert.ok(f.labels.indexOf('Recent project') >= 0);
	assert.ok(f.labels.indexOf('Recent project') < f.labels.indexOf('Open Folder…'));
	f.choose('Recent project');
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/recent').fsPath });
});

test('Workspace includes recent active Session folders from the draft host after explicit recents', async () => {
	const session = (id: string, lastActivity: number, providerId = 'host', status: ISession['status'] = 'active'): ISession => ({
		sessionId: id, title: id, status, providerId, nextApprovalMode: 'manual',
		workspace: { authorityId: 'local', root: URI.file(`/${id}`).fsPath },
		chats: [{ threadId: id, status: 'active', origin: { type: 'root' }, updatedAt: new Date(lastActivity) }],
	});
	using f = fixture(undefined, [
		session('earlier', 10), session('latest', 20), session('recent', 30),
		session('archived', 40, 'host', 'archived'), session('other-host', 50, 'another-host'),
	]);
	await f.open();
	assert.deepEqual(f.labels.slice(0, f.labels.indexOf('Open Folder…')), ['Recent project', 'latest', 'earlier']);
	f.choose('latest');
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/latest').fsPath });
});

test('New worktree validates a branch and changes the draft without creating a conversation', async () => {
	using f = fixture();
	await f.open();
	f.choose('New worktree…');
	assert.equal(await f.inputOptions?.validateInput?.('../escape'), 'Enter a valid new Git branch name.');
	assert.equal(await f.inputOptions?.validateInput?.('review/topic'), undefined);
	const updated = new Promise<void>(resolve => Event.once(f.changed.event)(resolve));
	await f.branch.complete('review/topic');
	await updated;
	assert.equal(f.drafts[0]?.branchName, 'review/topic');
	assert.equal(f.drafts[1]?.branchName, undefined);
	assert.equal(f.button.textContent, 'Worktree · review/topic');
});

test('A native folder dialog cannot publish after its conversation was switched or disposed', async () => {
	for (const action of ['switch', 'dispose', 'submit', 'hide']) {
		using f = fixture();
		await f.open();
		f.choose('Open Folder…');
		if (action === 'dispose') { f.control.dispose(); }
		if (action === 'hide') { f.control.setVisible(false); }
		if (action === 'switch') { f.model.untitledSessionId = 'second'; }
		if (action === 'submit') { f.model.inputState.phase = 'submitting'; }
		f.updated.fire();
		await f.dialog.complete([URI.file('/late')]);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal((f.drafts[0]?.workspace as SessionExecutionTarget).root, URI.file('/project').fsPath);
		assert.equal((f.drafts[1]?.workspace as SessionExecutionTarget).root, URI.file('/project').fsPath);
		assert.deepEqual(f.errors, []);
	}
});

test('Browsing a local folder changes only the owning conversation without changing the Project window', async () => {
	using f = fixture();
	await f.open();
	f.choose('Open Folder…');
	const updated = new Promise<void>(resolve => Event.once(f.changed.event)(resolve));
	await f.dialog.complete([URI.file('/another')]);
	await updated;
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/another').fsPath });
	assert.deepEqual(f.drafts[1]?.workspace, { type: 'local', root: URI.file('/project').fsPath });
	await f.open();
	assert.equal(f.labels[0], 'another');
});

test('Browsing a remote conversation preserves its host instead of opening a local native dialog', async () => {
	using f = fixture({ type: 'ssh', host: 'build', root: '/source' });
	await f.open();
	f.choose('Open Folder…');
	assert.equal(f.inputOptions?.value, '/source');
	const updated = new Promise<void>(resolve => Event.once(f.changed.event)(resolve));
	await f.branch.complete('/another');
	await updated;
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'ssh', host: 'build', root: '/another' });
});

test('Workspace cancellation keeps the draft and the Chinese picker exposes translated worktree actions', async () => {
	const translations = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/sessions.json', 'utf8'));
	setNlsMessages('zh-CN', translations);
	try {
		using f = fixture();
		await f.open();
		f.choose('打开文件夹…');
		await f.dialog.complete(undefined);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.button.ownerDocument.activeElement, f.button);
		await f.open();
		f.choose('新建 worktree…');
		assert.equal(f.inputOptions?.placeHolder, '新分支名；首次发送消息时创建');
		await f.branch.complete(undefined);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.drafts[0]?.branchName, undefined);
		assert.equal(f.button.ownerDocument.activeElement, f.button);
	} finally {
		resetNlsResolver();
	}
});
