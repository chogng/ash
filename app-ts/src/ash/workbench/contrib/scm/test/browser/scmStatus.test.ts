import assert from 'node:assert/strict';
import { test } from 'mocha';
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
import { GitSCMProvider, type GitSCMProviderServices } from '../../../git/browser/gitSCMProvider.js';
import type { GitHistoryProvider } from '../../../git/browser/gitHistoryProvider.js';
import { GitSwitchBranchCommandId } from '../../../git/common/gitCommands.js';
import type { GitStatus, IGitService } from '../../../git/common/gitService.js';
import { IStatusbarService, StatusbarAlignment, StatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import type { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';

test('SCM status displays provider branch and upstream commands', async () => {
	const changes = new Emitter<GitStatus>();
	let status = branchStatus(2, 3);
	const commands: Array<{ id: string; repositoryId: string }> = [];
	const focusedViews: string[] = [];
	using fixture = createFixture(changes, () => Promise.resolve(status), commands, focusedViews);
	await settle();
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.id), ['ash.status.git.branch', 'ash.status.git.sync']);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ['main', '3↓ 2↑']);
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left).map(item => item.compactGroup), ['ash.status.git', 'ash.status.git']);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.icon, Lxicon.sync);
	await fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.();
	assert.equal(await fixture.statusbar.getEntries(StatusbarAlignment.Left)[1]?.entry.run?.(), true);
	assert.deepEqual(commands, [{ id: GitSwitchBranchCommandId, repositoryId: 'repo-1' }]);
	assert.deepEqual(focusedViews, ['ash.gitView']);

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

function createFixture(changes: Emitter<GitStatus>, status: () => Promise<GitStatus>, commands: Array<{ id: string; repositoryId: string }>, focusedViews: string[]): DisposableStore & { readonly statusbar: StatusbarService; readonly viewService: SCMViewService } {
	const resources = new DisposableStore();
	resources.add(changes);
	const scmService = resources.add(new SCMService());
	const viewService = resources.add(new SCMViewService(scmService));
	const statusbar = resources.add(new StatusbarService());
	const git = {
		onDidChangeRepositoryStatus: changes.event,
		onDidBecomeReady: Event.None,
		status,
	} as unknown as IGitService;
	const services: GitSCMProviderServices = {
		commandService: { executeCommand: async (id: string, repositoryId: string) => { commands.push({ id, repositoryId }); } } as unknown as ICommandService,
		viewsService: { focusView: async (id: string) => { focusedViews.push(id); return true; } } as unknown as IViewsService,
		dialogService: {} as IDialogService,
		editorService: {} as IEditorService,
		workingCopyService: {} as IWorkingCopyService,
	};
	const provider = resources.add(new GitSCMProvider(git, { id: 'repo-1', label: 'workspace', path: '/workspace', root: URI.file('/workspace') }, {} as GitHistoryProvider, services));
	resources.add(scmService.registerSCMProvider(provider));
	const container = resources.add(new InstantiationService());
	container.registerInstance(ISCMViewService, viewService);
	container.registerInstance(IStatusbarService, statusbar);
	resources.add(container.createInstance(ScmStatusContribution));
	return Object.assign(resources, { statusbar, viewService });
}

function branchStatus(ahead: number, behind: number, name = 'main'): GitStatus {
	return {
		repositoryId: 'repo-1', streamInstanceId: 'git-stream', revision: 1, workspacePath: '.',
		head: { type: 'branch', name, objectId: 'abcdef1234567890', upstream: { name: `origin/${name}`, ahead, behind } }, changes: [],
	};
}

function detachedStatus(): GitStatus {
	return {
		repositoryId: 'repo-1', streamInstanceId: 'git-stream', revision: 2, workspacePath: '.',
		head: { type: 'detached', objectId: '1234567890abcdef' }, changes: [],
	};
}

function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
