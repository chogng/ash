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
import { IQuickInputService, type IInputOptions, type IQuickPick, type IQuickPickItem, type IQuickPickDidAcceptEvent } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IChatWidgetModel } from '../../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession, SessionExecutionTarget, SessionWorkspaceSelection } from '../../../../services/sessions/common/session.js';
import { SessionWorkspacePicker } from '../../browser/sessionWorkspacePicker.js';

function fixture(target: SessionExecutionTarget = { type: 'local', root: URI.file('/project').fsPath }) {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	lifetime.add(setARIAContainer(dom.window.document.body));
	const services = lifetime.add(new InstantiationService());
	const changed = lifetime.add(new Emitter<void>());
	const updated = lifetime.add(new Emitter<void>());
	const accepted = lifetime.add(new Emitter<IQuickPickDidAcceptEvent>());
	const hidden = lifetime.add(new Emitter<void>());
	const loaded = lifetime.add(new Emitter<void>());
	const dialog = new DeferredPromise<readonly URI[] | undefined>();
	const branch = new DeferredPromise<string | undefined>();
	let inputOptions: IInputOptions | undefined;
	let drafts: readonly IUntitledChatSession[] = ['first', 'second'].map(id => ({
		untitledSessionId: id, title: id, providerId: 'host', model: undefined, agent: undefined, workspace: target,
	}));
	let items: readonly IQuickPickItem[] = [];
	let disposed = false;
	const picker = {
		get items() { return items; },
		set items(value: readonly IQuickPickItem[]) { items = value; loaded.fire(); },
		selectedItems: [] as readonly IQuickPickItem[],
		onDidAccept: accepted.event, onDidHide: hidden.event, show() { },
		dispose() { disposed = true; }, [Symbol.dispose]() { disposed = true; },
	} as unknown as IQuickPick<IQuickPickItem>;
	const model = { untitledSessionId: 'first', inputState: { phase: 'ready' }, onDidChange: updated.event };
	const errors: unknown[] = [];
	services.registerInstance(INotificationService, { error: (error: unknown) => { errors.push(error); } } as unknown as INotificationService);
	services.registerInstance(ISessionsManagementService, {
		get untitledSessions() { return drafts; }, sessions: [], onDidChange: changed.event,
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
	services.registerInstance(IFileDialogService, { showOpenDialog: () => dialog.p } as unknown as IFileDialogService);
	services.registerInstance(IQuickInputService, {
		createQuickPick: () => picker,
		input: (options: IInputOptions) => { inputOptions = options; return branch.p; },
	} as unknown as IQuickInputService);
	const control = lifetime.add(services.createInstance(SessionWorkspacePicker, dom.window.document.body, model as unknown as IChatWidgetModel));
	const button = dom.window.document.querySelector('button')!;
	return {
		button, control, model, changed, updated, dialog, branch, errors,
		get drafts() { return drafts; }, get inputOptions() { return inputOptions; }, get disposed() { return disposed; },
		async open() {
			button.click();
			await new Promise<void>(resolve => lifetime.add(Event.once(loaded.event)(resolve)));
		},
		choose(label: string) {
			const item = picker.items.find(item => item.label === label);
			assert.ok(item && !('type' in item), `Missing choice: ${label}`);
			picker.selectedItems = [item];
			accepted.fire({ inBackground: false });
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
		f.choose('Browse folders…');
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
	f.choose('Browse folders…');
	const updated = new Promise<void>(resolve => Event.once(f.changed.event)(resolve));
	await f.dialog.complete([URI.file('/another')]);
	await updated;
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/another').fsPath });
	assert.deepEqual(f.drafts[1]?.workspace, { type: 'local', root: URI.file('/project').fsPath });
});

test('Browsing a remote conversation preserves its host instead of opening a local native dialog', async () => {
	using f = fixture({ type: 'ssh', host: 'build', root: '/source' });
	await f.open();
	f.choose('Browse folders…');
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
