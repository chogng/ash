import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { setLanguage } from '../../../../../../../extensions/git/browser/support.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ISCMViewService } from '../../common/scm.js';
import { URI } from '../../../../../base/common/uri.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ScmStatusContribution } from '../../browser/activity.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { GitSCMProvider, type GitSCMProviderServices } from '../../../../../../../extensions/git/browser/gitSCMProvider.js';
import type { GitHistoryProvider } from '../../../../../../../extensions/git/browser/gitHistoryProvider.js';
import { GitSwitchBranchCommandId } from '../../../../../../../extensions/git/browser/commandIds.js';
import type { GitStatus, IGitService } from '../../../../../../../extensions/git/browser/types.js';
import { IStatusbarService, StatusbarAlignment, StatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import type { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';

test('SCM status displays provider branch and upstream commands', async () => {
	const changes = new Emitter<GitStatus>();
	let status = branchStatus(2, 3);
	const commands: Array<{ id: string; repositoryId: string; }> = [];
	const focusedViews: string[] = [];
	using fixture = createFixture(changes, () => Promise.resolve(status), commands, focusedViews);
	await settle();
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.id), ['ash.status.git.branch', 'ash.status.git.sync']);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ['main', '3↓ 2↑']);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.compactGroup), ['ash.status.git', 'ash.status.git']);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.icon, Lxicon.sync);
	await fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.();
	await fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.run?.();
	assert.deepEqual(commands, [{ id: GitSwitchBranchCommandId, repositoryId: 'repo-1' }, { id: 'git.sync', repositoryId: 'repo-1' }]);
	assert.deepEqual(focusedViews, []);

	status = detachedStatus();
	changes.fire(status);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ['12345678', '']);
	fixture.viewService.selectRepository(undefined);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
});

test('Git provider status events supersede an older in-flight status request', async () => {
	const changes = new Emitter<GitStatus>();
	let resolveInitial!: (status: GitStatus) => void;
	const initial = new Promise<GitStatus>(resolve => { resolveInitial = resolve; });
	using fixture = createFixture(changes, () => initial, [], []);
	changes.fire(branchStatus(4, 5, 'event-branch'));
	resolveInitial(branchStatus(1, 1, 'stale-branch'));
	await settle();
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'event-branch');
});

test('SCM status publishes untracked branches and disables synchronization without a committed branch', async () => {
	const changes = new Emitter<GitStatus>();
	const initial: GitStatus = { ...branchStatus(0, 0), head: { type: 'branch', name: 'main', objectId: 'abc', upstream: undefined } };
	const commands: Array<{ id: string; repositoryId: string; }> = [];
	using fixture = createFixture(changes, async () => initial, commands, []);
	await settle();
	await fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.run?.();
	assert.deepEqual(commands, [{ id: 'git.publish', repositoryId: 'repo-1' }]);
	changes.fire(detachedStatus());
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.run, undefined);
	changes.fire({ ...initial, revision: 3, head: { type: 'unborn', name: 'new' } });
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.run, undefined);
});

test('Git sync pulls before pushing, disables status actions, and refreshes upstream counts', async () => {
	const changes = new Emitter<GitStatus>();
	const pull = new DeferredPromise<GitStatus>();
	const calls: string[] = [];
	const initial = branchStatus(2, 3);
	using fixture = createFixture(changes, async () => initial, [], [], {
		pull: async (id, mode) => { calls.push(`pull:${id}:${mode}`); return pull.p; },
		push: async id => { calls.push(`push:${id}`); return { ...branchStatus(0, 0), revision: 3 }; },
	});
	await settle();
	const syncing = fixture.provider.sync();
	await settle();
	await fixture.provider.sync();
	assert.deepEqual(calls, ['pull:repo-1:sync']);
	assert.ok(fixture.statusbar.getEntries(StatusbarAlignment.Left).every(item => !item.entry.run));
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.tooltip, 'Synchronizing Changes…');
	await pull.complete({ ...branchStatus(2, 0), revision: 2 });
	await syncing;
	assert.deepEqual(calls, ['pull:repo-1:sync', 'push:repo-1']);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.text, '');
	assert.ok(fixture.statusbar.getEntries(StatusbarAlignment.Left).every(item => item.entry.run));
});

test('Git sync stops before push when pull fails and restores actions with a localized busy label', async () => {
	const changes = new Emitter<GitStatus>();
	const pull = new DeferredPromise<GitStatus>();
	let pushes = 0;
	setLanguage('zh-CN');
	try {
		using fixture = createFixture(changes, async () => branchStatus(0, 3), [], [], {
			pull: async () => pull.p,
			push: async () => { pushes++; return branchStatus(0, 0); },
		});
		await settle();
		const syncing = fixture.provider.sync();
		await settle();
		assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.ariaLabel, '正在同步更改…');
		await pull.error(new Error('Pull rejected'));
		await syncing;
		assert.equal(pushes, 0);
		assert.equal(fixture.provider.statusMessage, 'Pull rejected');
		assert.ok(fixture.statusbar.getEntries(StatusbarAlignment.Left).every(item => item.entry.run));
	} finally { setLanguage('en'); }
});

test('Git sync does not push after a concurrent checkout or an unresolved conflict', async () => {
	for (const pulled of [{ ...branchStatus(0, 0, 'other'), revision: 2 }, { ...branchStatus(0, 0), revision: 2, changes: [{ path: 'one.ts', originalPath: undefined, submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false }, indexStatus: 'unmerged' as const, worktreeStatus: 'unmerged' as const, conflicted: true }] }]) {
		const changes = new Emitter<GitStatus>();
		let pushes = 0;
		using fixture = createFixture(changes, async () => branchStatus(0, 3), [], [], {
			pull: async () => pulled,
			push: async () => { pushes++; return branchStatus(0, 0); },
		});
		await settle();
		await fixture.provider.sync();
		assert.equal(pushes, 0);
	}
});

function createFixture(changes: Emitter<GitStatus>, status: () => Promise<GitStatus>, commands: Array<{ id: string; repositoryId: string; }>, focusedViews: string[], operations: Partial<IGitService> = {}): DisposableStore & { readonly statusbar: StatusbarService; readonly viewService: SCMViewService; readonly provider: GitSCMProvider; } {
	const resources = new DisposableStore();
	resources.add(changes);
	const scmService = resources.add(new SCMService());
	const viewService = resources.add(new SCMViewService(scmService));
	const statusbar = resources.add(new StatusbarService());
	const git = {
		onDidChangeRepositoryStatus: changes.event,
		onDidBecomeReady: Event.None,
		status,
		...operations,
	} as unknown as IGitService;
	const services: GitSCMProviderServices = {
		notify: () => { },
		configuration: { get: (_key, defaultValue) => defaultValue, onDidChange: Event.None },
		commandService: { executeCommand: async (id: string, repositoryId: string) => { commands.push({ id, repositoryId }); } } as unknown as ICommandService,
		viewsService: { focusView: async (id: string) => { focusedViews.push(id); return true; } } as unknown as IViewsService,
		dialogService: { confirm: async () => ({ confirmed: true }) },
		editorService: {} as IEditorService,
		workingCopyService: {} as IWorkingCopyService,
	};
	const provider = resources.add(new GitSCMProvider(git, { id: 'repo-1', label: 'workspace', path: '/workspace', root: URI.file('/workspace') }, {} as GitHistoryProvider, services));
	resources.add(scmService.registerSCMProvider(provider));
	const container = resources.add(new InstantiationService());
	container.registerInstance(ISCMViewService, viewService);
	container.registerInstance(IStatusbarService, statusbar);
	resources.add(container.createInstance(ScmStatusContribution));
	return Object.assign(resources, { statusbar, viewService, provider });
}

function branchStatus(ahead: number, behind: number, name = 'main'): GitStatus {
	return {
		repositoryId: 'repo-1', streamInstanceId: 'git-stream', historyRevision: 1, revision: 1, workspacePath: '.',
		head: { type: 'branch', name, objectId: 'abcdef1234567890', upstream: { name: `origin/${name}`, ahead, behind } }, changes: [],
	};
}

function detachedStatus(): GitStatus {
	return {
		repositoryId: 'repo-1', streamInstanceId: 'git-stream', historyRevision: 1, revision: 2, workspacePath: '.',
		head: { type: 'detached', objectId: '1234567890abcdef' }, changes: [],
	};
}

function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
