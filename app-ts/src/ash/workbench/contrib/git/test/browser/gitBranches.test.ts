import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { AppServerRemoteError } from '../../../../../platform/app-server/common/appServerError.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { type GitBranch, IGitService } from '../../common/gitService.js';
import { GitCreateBranchCommandId, GitDeleteBranchCommandId, GitSwitchBranchCommandId } from '../../common/gitCommands.js';
import '../../browser/gitBranches.js';
import '../../browser/git.contribution.js';

test('Git create branch command cancels without writing and pins the repository while entering a name', async () => {
	const calls: string[] = [];
	let name: string | undefined;
	let activeRepository = { id: 'repo-1' };
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async () => ({ ...activeRepository }),
		branches: async (repositoryId?: string) => { calls.push(`list:${repositoryId}`); activeRepository = { id: 'repo-2' }; return [{ name: 'main', current: true }]; },
		createBranch: async (branch: string, repositoryId?: string) => { calls.push(`create:${repositoryId}:${branch}`); },
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, {
		input: async () => { activeRepository = { id: 'repo-2' }; return name; },
	} as unknown as IQuickInputService);
	services.registerInstance(INotificationService, { info: (message: string) => { calls.push(message); } } as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand(GitCreateBranchCommandId);
	assert.deepEqual(calls, ['list:repo-1']);
	calls.length = 0;
	activeRepository = { id: 'repo-1' };
	name = ' topic ';
	await commands.executeCommand(GitCreateBranchCommandId);
	assert.deepEqual(calls, ['list:repo-1', 'create:repo-1:topic', 'Created branch topic. The current branch is unchanged.']);
});

test('Git delete branch command excludes the current branch, honors cancellation and reports rejected deletion', async () => {
	const calls: string[] = [];
	let confirmed = false;
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id }),
		branches: async () => [
			{ name: 'main', current: true },
			{ name: 'topic', current: false },
		],
		deleteBranch: async (name: string, repositoryId?: string) => {
			calls.push(`delete:${repositoryId}:${name}`);
			throw new AppServerRemoteError(-32061, 'GitOperationFailed', { kind: 'GitOperationFailed' });
		},
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, quickInputSelecting(() => 0, calls));
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed }) } as unknown as IDialogService);
	services.registerInstance(INotificationService, { error: (message: string) => { calls.push(`error:${message}`); } } as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand(GitDeleteBranchCommandId, 'repo-2');
	assert.deepEqual(calls, ['show:topic']);
	confirmed = true;
	await commands.executeCommand(GitDeleteBranchCommandId, 'repo-2');
	assert.deepEqual(calls, ['show:topic', 'show:topic', 'delete:repo-2:topic', 'error:Could not delete branch: Git rejected the deletion. Check unmerged commits and worktrees.']);
});

test('Git branch command lists the selected repository and switches the chosen branch', async () => {
	const calls: string[] = [];
	const branches: readonly GitBranch[] = [
		{ name: 'main', objectId: 'one', current: true, upstream: 'origin/main' },
		{ name: 'feature', objectId: 'two', current: false, upstream: undefined },
	];
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id }),
		branches: async (repositoryId?: string) => { calls.push(`list:${repositoryId}`); return branches; },
		switchBranch: async (name: string, repositoryId?: string) => { calls.push(`switch:${repositoryId}:${name}`); return {} as never; },
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, quickInputSelecting(() => 1, calls));
	services.registerInstance(INotificationService, { error: (message: string) => { calls.push(`error:${message}`); } } as INotificationService);
	using commands = new CommandService(services);

	await commands.executeCommand(GitSwitchBranchCommandId, 'repo-2');

	assert.deepEqual(calls, ['list:repo-2', 'show:main,feature', 'switch:repo-2:feature']);
});

test('Git branch command leaves the current branch alone and reports a rejected switch', async () => {
	const branches: readonly GitBranch[] = [
		{ name: 'main', objectId: 'one', current: true, upstream: undefined },
		{ name: 'topic', objectId: 'two', current: false, upstream: undefined },
	];
	const calls: string[] = [];
	let chosen = 0;
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id: id ?? 'repo-1' }),
		branches: async () => branches,
		switchBranch: async (name: string, repositoryId?: string) => { calls.push(`switch:${repositoryId}:${name}`); throw new AppServerRemoteError(-32061, 'GitOperationFailed', { kind: 'GitOperationFailed' }); },
	} as unknown as IGitService);
	services.registerInstance(INotificationService, { error: (message: string) => { calls.push(`error:${message}`); } } as INotificationService);
	services.registerInstance(IQuickInputService, quickInputSelecting(() => chosen, calls));
	using commands = new CommandService(services);

	await commands.executeCommand(GitSwitchBranchCommandId);
	assert.deepEqual(calls, ['show:main,topic']);

	chosen = 1;
	await commands.executeCommand(GitSwitchBranchCommandId);
	assert.deepEqual(calls, [
		'show:main,topic',
		'show:main,topic',
		'switch:repo-1:topic',
		'error:Could not switch branch: Git rejected the switch. Check local changes and worktrees.',
	]);
});

function quickInputSelecting(index: () => number, calls: string[]): IQuickInputService {
	return {
		createQuickPick: <T extends IQuickPickItem>() => {
			const accept = new Emitter<T>();
			const hide = new Emitter<void>();
			const picker = {
				items: [] as readonly T[],
				ariaLabel: '',
				placeholder: '',
				onDidAccept: accept.event,
				onDidHide: hide.event,
				show(): void {
					calls.push(`show:${this.items.map(item => item.label).join(',')}`);
					queueMicrotask(() => accept.fire(this.items[index()]!));
				},
				hide(): void { hide.fire(); },
				dispose(): void { accept.dispose(); hide.dispose(); },
				[Symbol.dispose](): void { this.dispose(); },
			};
			return picker as unknown as IQuickPick<T>;
		},
	} as IQuickInputService;
}

test('Git stash command pins its repository before prompting and keeps picker resources until acceptance', async () => {
	const calls: unknown[] = [];
	let active = 'repo-1';
	let entered: string | undefined;
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async () => ({ id: active }),
		executeCommand: async (command: unknown, repositoryId: string) => {
			calls.push({ command, repositoryId });
			return { outcome: 'conflicted' };
		},
	} as unknown as IGitService);
	const pickerCalls: string[] = [];
	services.registerInstance(IQuickInputService, {
		...quickInputSelecting(() => 1, pickerCalls),
		input: async () => { active = 'repo-2'; return entered; },
	});
	services.registerInstance(INotificationService, {
		warning: (message: string) => { calls.push(message); },
		error: (message: string) => { calls.push(message); },
	} as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand('git.stash');
	assert.deepEqual(calls, []);
	active = 'repo-1';
	entered = 'review';
	await commands.executeCommand('git.stash');
	assert.deepEqual(calls, [
		{ command: { kind: 'stash', message: 'review', mode: 'includeUntracked' }, repositoryId: 'repo-1' },
		'The stash has conflicts. Resolve the files in Source Control. The stash is kept until you delete it.',
	]);
	assert.deepEqual(pickerCalls, ['show:Tracked changes,Tracked and untracked changes']);
});

test('Git continue reads durable integration state and abort honors declined confirmation', async () => {
	const calls: unknown[] = [];
	let operation: 'rebase' | undefined;
	let confirmed = false;
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async () => ({ id: 'repo-1' }),
		catalog: async () => ({ operation }),
		executeCommand: async (command: unknown, repositoryId: string) => {
			calls.push({ command, repositoryId }); return { outcome: 'completed' };
		},
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, {} as IQuickInputService);
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed }) } as unknown as IDialogService);
	services.registerInstance(INotificationService, { info: (message: string) => { calls.push(message); }, error: (message: string) => { calls.push(message); } } as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand('git.continue');
	assert.deepEqual(calls, ['No merge, rebase or cherry-pick is in progress.']);
	calls.length = 0;
	operation = 'rebase';
	await commands.executeCommand('git.abort');
	assert.deepEqual(calls, []);
	confirmed = true;
	await commands.executeCommand('git.abort');
	await commands.executeCommand('git.continue');
	assert.deepEqual(calls, [
		{ command: { kind: 'abort', operation: 'rebase' }, repositoryId: 'repo-1' }, 'Git operation completed.',
		{ command: { kind: 'continue', operation: 'rebase' }, repositoryId: 'repo-1' }, 'Git operation completed.',
	]);
});

test('Git hunk action sends its reviewed comparison and selected block to the pinned repository', async () => {
	const calls: unknown[] = [];
	const reviewed = { original: 'old\n', modified: 'new\n', hunks: [{ index: 2, newStart: 1, newCount: 1, preview: 'new' }] };
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async () => ({ id: 'repo-1' }),
		status: async () => ({ changes: [{ path: 'file.txt', conflicted: false, indexStatus: 'unmodified', worktreeStatus: 'modified' }] }),
		indexDiff: async () => reviewed,
		editIndex: async (...args: unknown[]) => { calls.push(args); },
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, quickInputSelecting(() => 0, []));
	services.registerInstance(INotificationService, { info: () => {}, error: (message: string) => { calls.push(message); } } as unknown as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand('git.stageHunk');
	assert.deepEqual(calls, [['file.txt', 'unstaged', reviewed, { kind: 'hunk', index: 2 }, 'repo-1']]);
});
