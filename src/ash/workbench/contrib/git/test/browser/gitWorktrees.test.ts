import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { AppServerRemoteError } from '../../../../../platform/app-server/common/appServerError.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IInputOptions, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IWorkspaceOpenService } from '../../../../services/workspaces/browser/workspaceOpenService.js';
import { GitCreateWorktreeCommandId, GitDeleteWorktreeCommandId, GitOpenWorktreeCommandId } from '../../common/gitCommands.js';
import { IGitService, type GitWorktree } from '../../common/gitService.js';
import '../../browser/gitWorktrees.js';

const worktrees: readonly GitWorktree[] = [
	{ checkoutRoot: '/primary', path: '/primary/nested', branch: 'main', head: 'one', current: true, state: 'ready' },
	{ checkoutRoot: '/linked', path: '/linked/nested', branch: undefined, head: 'one', current: false, state: 'ready' },
	{ checkoutRoot: '/session', path: '/session/nested', branch: undefined, head: 'one', current: false, state: 'threadOwned' },
	{ checkoutRoot: '/locked', path: '/locked/nested', branch: 'topic', head: 'one', current: false, state: 'locked' },
];

test('Git worktree opening excludes unavailable targets and uses the backend-resolved nested directory', async () => {
	const calls: string[] = [];
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id }),
		worktrees: async () => worktrees,
		resolveWorktree: async (checkoutRoot: string, repositoryId?: string) => {
			calls.push(`resolve:${repositoryId}:${checkoutRoot}`);
			return '/resolved/nested';
		},
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, quickInputSelecting(true, calls));
	services.registerInstance(IWorkspaceOpenService, { openWorkspace: async (path: string) => { calls.push(`open:${path}`); } } as IWorkspaceOpenService);
	services.registerInstance(INotificationService, { error: (message: string) => { calls.push(`error:${message}`); } } as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand(GitOpenWorktreeCommandId, 'repo-2');
	assert.deepEqual(calls, ['pick:/linked', 'dispose', 'resolve:repo-2:/linked', 'open:/resolved/nested']);
});

test('Git worktree picker cancellation releases the picker without resolving or opening a workspace', async () => {
	const calls: string[] = [];
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id }),
		worktrees: async () => worktrees,
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, quickInputSelecting(false, calls));
	services.registerInstance(INotificationService, {} as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand(GitOpenWorktreeCommandId, 'repo-2');
	assert.deepEqual(calls, ['pick:/linked', 'dispose']);
});

test('Git worktree deletion honors confirmation and never retries a rejected removal', async () => {
	const calls: string[] = [];
	let confirmed = false;
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id }),
		worktrees: async () => worktrees,
		deleteWorktree: async (checkoutRoot: string, repositoryId?: string) => {
			calls.push(`delete:${repositoryId}:${checkoutRoot}`);
			throw new AppServerRemoteError(-32061, 'GitOperationFailed', { kind: 'GitOperationFailed' });
		},
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, quickInputSelecting(true, calls));
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed }) } as unknown as IDialogService);
	services.registerInstance(INotificationService, { error: (message: string) => { calls.push(`error:${message}`); } } as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand(GitDeleteWorktreeCommandId, 'repo-2');
	assert.deepEqual(calls, ['pick:/linked', 'dispose']);
	confirmed = true;
	await commands.executeCommand(GitDeleteWorktreeCommandId, 'repo-2');
	assert.deepEqual(calls, [
		'pick:/linked', 'dispose', 'pick:/linked', 'dispose', 'delete:repo-2:/linked',
		'error:Could not delete worktree: The worktree could not be deleted. Check local changes, locks and session ownership.',
	]);
});

test('Git worktree creation validates its name and opens only the returned backend path', async () => {
	const calls: string[] = [];
	using services = new InstantiationService();
	services.registerInstance(IGitService, {
		getRepository: async (id?: string) => ({ id }),
		createWorktree: async (name: string, repositoryId?: string) => { calls.push(`create:${repositoryId}:${name}`); return '/created/nested'; },
	} as unknown as IGitService);
	services.registerInstance(IQuickInputService, {
		input: async (options: IInputOptions) => {
			assert.equal(await options.validateInput?.('../escape'), 'Use 1–64 letters, numbers, hyphens or underscores.');
			assert.equal(await options.validateInput?.('review_1'), undefined);
			return ' review_1 ';
		},
	} as IQuickInputService);
	services.registerInstance(IWorkspaceOpenService, { canOpenWorkspace: true, openWorkspace: async (path: string) => { calls.push(`open:${path}`); } } as IWorkspaceOpenService);
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed: true }) } as unknown as IDialogService);
	services.registerInstance(INotificationService, { info: (message: string) => { calls.push(message); } } as INotificationService);
	using commands = new CommandService(services);
	await commands.executeCommand(GitCreateWorktreeCommandId, 'repo-2');
	assert.deepEqual(calls, ['create:repo-2:review_1', 'Created worktree at /created/nested.', 'open:/created/nested']);
});

function quickInputSelecting(acceptSelection: boolean, calls: string[]): IQuickInputService {
	return {
		createQuickPick: <T extends IQuickPickItem>() => {
			const accept = new Emitter<T>();
			const hide = new Emitter<void>();
			const picker = {
				items: [] as readonly T[],
				ariaLabel: '', placeholder: '',
				onDidAccept: accept.event,
				onDidHide: hide.event,
				show(): void {
					assert.ok(this.ariaLabel);
					calls.push(`pick:${this.items.map(item => item.label).join(',')}`);
					queueMicrotask(() => acceptSelection ? accept.fire(this.items[0]!) : hide.fire());
				},
				dispose(): void { calls.push('dispose'); accept.dispose(); hide.dispose(); },
				[Symbol.dispose](): void { this.dispose(); },
			};
			return picker as unknown as IQuickPick<T>;
		},
	} as IQuickInputService;
}
