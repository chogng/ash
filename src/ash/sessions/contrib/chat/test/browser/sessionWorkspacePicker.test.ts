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
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { ILocalGitService } from '../../../../../platform/git/common/localGitService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, type IActionListItem, type IActionListDelegate } from '../../../../../platform/actionWidget/browser/actionList.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { IQuickInputService, type IInputOptions } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService, type IRecent } from '../../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IChatWidgetModel } from '../../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ISessionFolderAuthorizationService } from '../../../../common/sessionWorkspace.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISession, IUntitledChatSession, SessionExecutionTarget, SessionWorkspaceSelection } from '../../../../services/sessions/common/session.js';
import { getSessionsChatAccessibilityHelp } from '../../browser/sessionsChatAccessibilityHelp.js';
import { SessionWorkspacePicker } from '../../browser/sessionWorkspacePicker.js';

function fixture(target: SessionExecutionTarget = { type: 'local', root: URI.file('/project').fsPath }, catalog: readonly ISession[] = [], additionalRecents: readonly IRecent[] = [], worktrees?: readonly { readonly label: string; readonly target: SessionExecutionTarget; readonly repository: SessionExecutionTarget; }[], windowFolder?: { readonly name: string; readonly uri: URI; }, gates?: { readonly worktrees: Promise<void>; readonly container: Promise<boolean>; readonly history: Promise<void>; }, authorize: ISessionFolderAuthorizationService['authorize'] = async () => true, isTrusted: ISessionFolderAuthorizationService['isTrusted'] = async () => true) {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	lifetime.add(toDisposable(() => dom.window.close()));
	lifetime.add(setARIAContainer(dom.window.document.body));
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(ISessionFolderAuthorizationService, { isTrusted, authorize });
	services.registerInstance(IStorageService, lifetime.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test' })));
	const changed = lifetime.add(new Emitter<void>());
	const updated = lifetime.add(new Emitter<void>());
	const loaded = lifetime.add(new Emitter<void>());
	const dialog = new DeferredPromise<readonly URI[] | undefined>();
	const branch = new DeferredPromise<string | undefined>();
	const checkout = new DeferredPromise<void>();
	const cloneStarted = new DeferredPromise<{ operation: string; url: string; target: string; }>();
	const cancelled: string[] = [];
	services.registerInstance(ILocalGitService, {
		async clone(operation: string, url: string, target: string) {
			await cloneStarted.complete({ operation, url, target });
			await checkout.p;
		},
		async cancel(operation: string) { cancelled.push(operation); },
	} as ILocalGitService);
	let inputOptions: IInputOptions | undefined;
	let drafts: readonly IUntitledChatSession[] = ['first', 'second'].map(id => ({
		untitledSessionId: id, title: id, providerId: LOCAL_AGENT_HOST_PROVIDER_ID, model: undefined, agent: undefined, workspace: target,
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
	const model = { untitledSessionId: 'first' as string | undefined, inputState: { phase: 'ready' }, onDidChange: updated.event };
	const errors: unknown[] = [];
	services.registerInstance(INotificationService, { error: (error: unknown) => { errors.push(error); } } as unknown as INotificationService);
	services.registerInstance(ISessionsManagementService, {
		get untitledSessions() { return drafts; }, sessions: catalog, onDidChange: changed.event,
		setUntitledSessionWorkspace(id: string, workspace: SessionWorkspaceSelection, options?: Parameters<ISessionsManagementService['setUntitledSessionWorkspace']>[2]) {
			drafts = drafts.map(draft => draft.untitledSessionId === id ? { ...draft, workspace, ...options } : draft);
			changed.fire();
		},
	} as unknown as ISessionsManagementService);
	let worktreeRequests = 0;
	const provider = {
		isDevContainerWorkspaceAvailable: async () => gates?.container ?? false,
		getWorktrees: async () => {
			worktreeRequests++;
			await gates?.worktrees;
			return worktrees ?? [{ label: 'main', target }, { label: 'review', target: { ...target, root: '/checkouts/review' } }];
		},
	};
	services.registerInstance(ISessionsProvidersService, {
		getProvider: () => provider, onDidChangeProviders: Event.None,
	} as unknown as ISessionsProvidersService);
	services.registerInstance(IWorkspaceContextService, {
		getWorkspace: () => ({ id: 'project', folders: windowFolder ? [windowFolder] : [] }), onDidChangeWorkspaceFolders: Event.None,
	} as unknown as IWorkspaceContextService);
	let history: readonly IRecent[] = [{ folderUri: URI.file('/recent'), label: 'Recent project' }, ...additionalRecents];
	services.registerInstance(IWorkspacesService, {
		getRecentlyOpened: async () => { await gates?.history; return { workspaces: history }; },
		addRecentlyOpened: async (entries: readonly IRecent[]) => { history = [...entries, ...history]; },
	} as unknown as IWorkspacesService);
	services.registerInstance(IFileDialogService, { showOpenDialog: () => dialog.p } as unknown as IFileDialogService);
	services.registerInstance(IQuickInputService, {
		input: (options: IInputOptions) => { inputOptions = options; return branch.p; },
	} as unknown as IQuickInputService);
	const control = lifetime.add(services.createInstance(SessionWorkspacePicker, dom.window.document.body, model as unknown as IChatWidgetModel));
	const button = dom.window.document.querySelector('button')!;
	return {
		button, control, model, changed, updated, loaded: loaded.event, dialog, branch, errors, checkout, cloneStarted, cancelled,
		get history() { return history; },
		get worktreeRequests() { return worktreeRequests; },
		get items() { return items; },
		get labels() { return items.map(item => item.label); }, get drafts() { return drafts; }, get inputOptions() { return inputOptions; }, get disposed() { return disposed; },
		async open() {
			button.click();
			await new Promise<void>(resolve => setImmediate(resolve));
		},
		choose(label: string) {
			const entry = items.flatMap(item => item.submenu ?? [item]).find(item => item.label === label);
			if (entry?.standaloneToggle) {
				return entry.standaloneToggle.onChange(!entry.standaloneToggle.checked);
			}
			const action = entry?.item;
			assert.ok(action && delegate, `Missing choice: ${label}`);
			return delegate.onSelect(action);
		},
		[Symbol.dispose]() { lifetime.dispose(); },
	};
}

test('Workspace picker hides when the composer moves from a draft to a session', () => {
	using f = fixture();
	const host = f.button.parentElement!;
	assert.equal(host.hidden, false);
	f.model.untitledSessionId = undefined;
	f.updated.fire();
	assert.equal(host.hidden, true);
	assert.equal(f.button.disabled, true);
});

test('A declined worktree grant leaves the draft on its original folder', async () => {
	const requested: string[] = [];
	using f = fixture(undefined, [], [], undefined, undefined, undefined, async path => {
		requested.push(path);
		return false;
	});
	await f.open();
	await f.choose('review');
	assert.deepEqual(requested, ['/checkouts/review']);
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/project').fsPath });
});

test('Workspace picks an existing worktree for only its owning independent conversation', async () => {
	using f = fixture();
	await f.open();
	await f.choose('review');
	assert.equal(f.drafts[0]?.workspace.type, 'local');
	assert.equal((f.drafts[0]?.workspace as SessionExecutionTarget).root, '/checkouts/review');
	assert.equal((f.drafts[1]?.workspace as SessionExecutionTarget).root, URI.file('/project').fsPath);
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	assert.equal(f.button.ownerDocument.activeElement, f.button);
	assert.deepEqual(f.errors, []);
});

test('Worktree controls are present while loading and become ready independently', async () => {
	const worktrees = new DeferredPromise<void>();
	const container = new DeferredPromise<boolean>();
	const history = new DeferredPromise<void>();
	using f = fixture(undefined, [], [], undefined, undefined, { worktrees: worktrees.p, container: container.p, history: history.p });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(f.worktreeRequests, 1);
	await f.open();
	assert.equal(f.worktreeRequests, 1);
	assert.deepEqual(f.labels.slice(-2), ['Loading branches…', 'New worktree']);
	assert.equal(f.items.at(-1)?.disabled, true);

	const updated = new Promise<void>(resolve => Event.once(f.loaded)(resolve));
	await worktrees.complete();
	await updated;
	assert.deepEqual(f.labels.slice(-2), ['main', 'New worktree']);
	assert.equal(f.items.at(-1)?.disabled, false);
	assert.ok(!f.labels.includes('Recent project'));
	await container.complete(false);
	await history.complete();
});

test('Branches and the worktree toggle form the last group', async () => {
	using f = fixture();
	await f.open();
	assert.deepEqual(f.items.map(item => item.kind === ActionListItemKind.Separator ? null : item.label), [
		'Recent project', null,
		'Clone Repository…', 'Open Folder…', null,
		'main', 'New worktree',
	]);
	const branches = f.items.find(item => item.label === 'main');
	assert.equal(branches?.group?.icon?.id, 'git-branch');
	assert.deepEqual(branches?.submenu?.map(item => [item.label, item.checked]), [['main', true], ['review', false]]);
	const toggle = f.items.find(item => item.label === 'New worktree');
	assert.equal(toggle?.group?.icon?.id, 'worktree');
	assert.equal(toggle?.standaloneToggle?.label, 'New worktree');
	assert.equal(toggle?.standaloneToggle?.checked, false);
	await f.choose('Recent project');
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/recent').fsPath });
});

test('Workspace rows show the folder name and use the full path for hover and accessibility', async () => {
	const project = URI.file('/work/project');
	const checkout = URI.file('/work/checkout');
	const archive = URI.file('/work/archive');
	using f = fixture(undefined, [], [
		{ folderUri: checkout },
		{ folderUri: archive, label: archive.fsPath },
	], undefined, { name: 'project', uri: project });
	await f.open();
	for (const [name, uri] of [['project', project], ['checkout', checkout], ['archive', archive]] as const) {
		const row = f.items.find(item => item.label === name);
		assert.ok(row);
		assert.equal(row.description, undefined);
		assert.equal(row.tooltip, uri.fsPath);
		assert.equal(row.detail, uri.fsPath);
	}
	await f.choose('project');
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: project.fsPath });
});

test('A recent checkout verified by the current host appears once as a worktree', async () => {
	using f = fixture(undefined, [], [
		{ folderUri: URI.file('/project'), label: 'Selected repository' },
		{ folderUri: URI.file('/checkouts/review'), label: 'Duplicate checkout' },
		{ folderUri: URI.file('/other.worktrees/review'), label: 'Unverified folder' },
	]);
	await f.open();
	assert.ok(f.items.some(item => item.submenu?.some(branch => branch.label === 'review')));
	assert.ok(f.labels.includes('Selected repository'));
	assert.ok(!f.labels.includes('Duplicate checkout'));
	assert.ok(f.labels.includes('Unverified folder'));
});

test('Recents fold a verified checkout under a different visible repository', async () => {
	const target = (root: string): SessionExecutionTarget => ({ type: 'local', root: URI.file(root).fsPath });
	using f = fixture(undefined, [], [
		{ folderUri: URI.file('/another-repo'), label: 'Another repository' },
		{ folderUri: URI.file('/checkouts/another'), label: 'Another checkout' },
		{ folderUri: URI.file('/checkouts/alone'), label: 'Standalone checkout' },
	], [
		{ label: 'another', target: target('/checkouts/another'), repository: target('/another-repo') },
		{ label: 'alone', target: target('/checkouts/alone'), repository: target('/missing-repo') },
	]);
	await f.open();
	assert.ok(f.labels.includes('Another repository'));
	assert.ok(!f.labels.includes('Another checkout'));
	assert.ok(!f.items.some(item => item.submenu?.some(branch => branch.label === 'another')));
	assert.ok(f.labels.includes('Standalone checkout'));
});

test('Workspace includes recent active Session folders from the draft host after explicit recents', async () => {
	const session = (id: string, lastActivity: number, providerId = LOCAL_AGENT_HOST_PROVIDER_ID, status: ISession['status'] = 'active'): ISession => ({
		sessionId: id, title: id, status, providerId, nextApprovalMode: 'manual',
		workspace: { authorityId: 'local', root: URI.file(`/${id}`).fsPath },
		chats: [{ threadId: id, status: 'active', origin: { type: 'root' }, updatedAt: new Date(lastActivity) }],
	});
	using f = fixture(undefined, [
		session('earlier', 10), session('latest', 20), session('recent', 30),
		session('archived', 40, LOCAL_AGENT_HOST_PROVIDER_ID, 'archived'), session('other-host', 50, 'another-host'),
	]);
	await f.open();
	assert.deepEqual(f.labels.slice(0, f.labels.indexOf('')), ['Recent project', 'latest', 'earlier']);
	await f.choose('latest');
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/latest').fsPath });
});

test('Folder candidates require existing trust without prompting', async () => {
	const trusted = URI.file('/trusted');
	const unchecked = URI.file('/unchecked');
	const failed = URI.file('/failed');
	const permission = new DeferredPromise<boolean>();
	using f = fixture(undefined, [], [
		{ folderUri: trusted, label: 'Trusted folder' },
		{ folderUri: failed, label: 'Unavailable folder' },
	], undefined, { name: 'Unchecked folder', uri: unchecked }, undefined,
		async () => assert.fail('Listing candidates must not request authorization'), async path => {
			if (path === failed.fsPath) throw new Error('Trust unavailable');
			return path === trusted.fsPath || (path === unchecked.fsPath && await permission.p);
		});
	await f.open();
	assert.ok(f.labels.includes('Trusted folder'));
	assert.ok(f.labels.includes('Open Folder…'));
	assert.ok(!f.labels.includes('Recent project'));
	assert.ok(!f.labels.includes('Unavailable folder'));
	assert.ok(!f.labels.includes('Unchecked folder'));
	const updated = new Promise<void>(resolve => Event.once(f.loaded)(resolve));
	await permission.complete(true);
	await updated;
	assert.ok(f.labels.includes('Unchecked folder'));
});

test('New worktree toggles the draft without prompting and retains the selected branch checkout', async () => {
	using f = fixture();
	await f.open();
	await f.choose('New worktree');
	const generatedBranch = f.drafts[0]?.branchName;
	assert.match(generatedBranch ?? '', /^ash\/[a-f0-9-]{36}$/u);
	assert.equal(f.inputOptions, undefined);
	assert.equal(f.drafts[1]?.branchName, undefined);
	assert.equal(f.button.getAttribute('aria-expanded'), 'true');
	assert.equal(f.items.find(item => item.label === 'New worktree')?.standaloneToggle?.checked, true);
	await f.choose('review');
	assert.equal((f.drafts[0]?.workspace as SessionExecutionTarget).root, '/checkouts/review');
	assert.equal(f.drafts[0]?.branchName, generatedBranch);
	await f.open();
	await f.choose('New worktree');
	assert.equal(f.items.find(item => item.label === 'New worktree')?.standaloneToggle?.checked, false);
	assert.equal(f.drafts[0]?.branchName, undefined);
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

test('Local folder selection waits for permission before changing the draft or recents', async () => {
	for (const accept of [false, true]) {
		const target = URI.file('/new-project');
		const requested = new DeferredPromise<string>();
		const answer = new DeferredPromise<boolean>();
		using f = fixture(undefined, [], [], undefined, undefined, undefined, async path => {
			await requested.complete(path);
			return answer.p;
		});
		await f.open();
		const selection = f.choose(accept ? 'Open Folder…' : 'Recent project');
		if (accept) { await f.dialog.complete([target]); }
		assert.equal(await requested.p, accept ? target.fsPath : URI.file('/recent').fsPath);
		assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/project').fsPath });
		assert.equal(f.history.length, 1);
		await answer.complete(accept);
		await selection;
		assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: accept ? target.fsPath : URI.file('/project').fsPath });
		assert.equal(f.history.length, accept ? 2 : 1);
	}
});

test('Browsing a remote conversation preserves its host instead of opening a local native dialog', async () => {
	using f = fixture({ type: 'ssh', host: 'build', root: '/source' });
	await f.open();
	assert.ok(!f.labels.includes('Clone Repository…'));
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
		assert.match(getSessionsChatAccessibilityHelp(), /选择尚未完全信任的本地文件夹时会打开信任对话框/);
		using f = fixture();
		await f.open();
		assert.ok(f.labels.includes('克隆仓库…'));
		f.choose('打开文件夹…');
		await f.dialog.complete(undefined);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.button.ownerDocument.activeElement, f.button);
		await f.open();
		await f.choose('新建工作树');
		assert.equal(f.inputOptions, undefined);
		assert.equal(f.items.find(item => item.label === '新建工作树')?.standaloneToggle?.checked, true);
		assert.equal(f.button.getAttribute('aria-expanded'), 'true');
	} finally {
		resetNlsResolver();
	}
});

test('Cloning from the workspace menu selects and records the new checkout after Git completes', async () => {
	using f = fixture();
	await f.open();
	const complete = f.choose('Clone Repository…');
	assert.ok(await f.inputOptions?.validateInput?.('https://example.test/org/CON.git'));
	assert.equal(await f.inputOptions?.validateInput?.('git@example.test:org/repo.git'), undefined);
	await f.branch.complete('git@example.test:org/repo.git');
	await f.dialog.complete([URI.file('/checkouts')]);
	const clone = await f.cloneStarted.p;
	assert.equal(clone.url, 'git@example.test:org/repo.git');
	assert.equal(clone.target, URI.file('/checkouts/repo').fsPath);
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: URI.file('/project').fsPath });
	await f.checkout.complete();
	await complete;
	assert.deepEqual(f.drafts[0]?.workspace, { type: 'local', root: clone.target });
	assert.deepEqual(f.drafts[1]?.workspace, { type: 'local', root: URI.file('/project').fsPath });
	assert.deepEqual(f.history[0], { folderUri: URI.file('/checkouts/repo'), label: 'repo' });
});

test('Switching drafts cancels the Git clone and ignores a late checkout result', async () => {
	using f = fixture();
	await f.open();
	const complete = f.choose('Clone Repository…');
	await f.branch.complete('https://example.test/org/repo.git');
	await f.dialog.complete([URI.file('/checkouts')]);
	const clone = await f.cloneStarted.p;
	f.model.untitledSessionId = 'second';
	f.updated.fire();
	await f.checkout.complete();
	await complete;
	assert.deepEqual(f.cancelled, [clone.operation]);
	assert.ok(f.drafts.every(draft => (draft.workspace as SessionExecutionTarget).root === URI.file('/project').fsPath));
	assert.equal(f.history.length, 1);
	assert.deepEqual(f.errors, []);
});
