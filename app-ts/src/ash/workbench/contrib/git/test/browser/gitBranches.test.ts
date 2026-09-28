import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { AppServerRemoteError } from '../../../../../platform/app-server/common/appServerError.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { type GitBranch, IGitService } from '../../common/gitService.js';
import { GitSwitchBranchCommandId } from '../../common/gitCommands.js';
import '../../browser/gitBranches.js';

test('Git branch command lists the selected repository and switches the chosen branch', async () => {
	const calls: string[] = [];
	const branches: readonly GitBranch[] = [
		{ name: 'main', objectId: 'one', current: true, upstream: 'origin/main' },
		{ name: 'feature', objectId: 'two', current: false, upstream: undefined },
	];
	using services = new ServiceContainer();
	services.registerInstance(IGitService, {
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
	using services = new ServiceContainer();
	services.registerInstance(IGitService, {
		activeRepository: { id: 'repo-1' },
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
				dispose(): void { accept.dispose(); hide.dispose(); },
				[Symbol.dispose](): void { this.dispose(); },
			};
			return picker as unknown as IQuickPick<T>;
		},
	} as IQuickInputService;
}
