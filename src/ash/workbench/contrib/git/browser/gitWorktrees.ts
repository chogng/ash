import { localize2, localize } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { AppServerRemoteError } from '../../../../platform/agentHost/common/appServerError.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceOpenService } from '../../../services/workspaces/browser/workspaceOpenService.js';
import { GitCreateWorktreeCommandId, GitDeleteWorktreeCommandId, GitOpenWorktreeCommandId } from '../common/gitCommands.js';
import { gitErrorMessage } from '../common/gitError.js';
import { IGitService, type GitWorktree } from '../common/gitService.js';

interface WorktreeItem extends IQuickPickItem {
	readonly worktree: GitWorktree;
}

registerAction2(class GitCreateWorktreeAction extends Action2 {
	constructor() {
		super({ id: GitCreateWorktreeCommandId, title: localize2({ bundle: 'ash', key: 'git.createWorktreeCommandTitle' }, 'Git: Create Worktree'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const targetRepositoryId = (await git.getRepository(repositoryId)).id;
			const name = await accessor.get(IQuickInputService).input({
				title: localize('git.createWorktreeCommandTitle', 'Git: Create Worktree'),
				placeHolder: localize('git.newWorktreeName', 'Name of the new detached worktree at HEAD'),
				validateInput: async value => /^[a-zA-Z0-9_-]{1,64}$/.test(value.trim())
					? undefined
					: localize('git.worktreeNameInvalid', 'Use 1–64 letters, numbers, hyphens or underscores.'),
			});
			if (name === undefined) { return; }
			const path = await git.createWorktree(name.trim(), targetRepositoryId);
			notifications.info(localize('git.worktreeCreated', 'Created worktree at {0}.', path));
			const workspaceOpen = accessor.get(IWorkspaceOpenService);
			if (!workspaceOpen.canOpenWorkspace) { return; }
			const confirmation = await accessor.get(IDialogService).confirm({
				title: localize('git.openWorktreeCommandTitle', 'Git: Open Worktree'),
				message: localize('git.openWorktreeConfirm', 'Open the worktree at {0}?', path),
				primaryButton: localize('git.openWorktreeButton', 'Open Worktree'),
			});
			if (confirmation.confirmed) { await workspaceOpen.openWorkspace(path); }
		} catch (error) {
			notifications.error(localize('git.createWorktreeFailed', 'Could not create or open worktree: {0}', gitErrorMessage(error)));
		}
	}
});

registerAction2(class GitOpenWorktreeAction extends Action2 {
	constructor() {
		super({ id: GitOpenWorktreeCommandId, title: localize2({ bundle: 'ash', key: 'git.openWorktreeCommandTitle' }, 'Git: Open Worktree'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const targetRepositoryId = (await git.getRepository(repositoryId)).id;
			const worktrees = await git.worktrees(targetRepositoryId);
			const selected = await pickWorktree(accessor.get(IQuickInputService), worktrees, localize('git.selectWorktreeToOpen', 'Select a Git worktree to open'));
			if (!selected) { return; }
			// Resolve again after selection: ownership and availability can change while the picker is open.
			const path = await git.resolveWorktree(selected.checkoutRoot, targetRepositoryId);
			await accessor.get(IWorkspaceOpenService).openWorkspace(path);
		} catch (error) {
			notifications.error(localize('git.openWorktreeFailed', 'Could not open worktree: {0}', gitErrorMessage(error)));
		}
	}
});

registerAction2(class GitDeleteWorktreeAction extends Action2 {
	constructor() {
		super({ id: GitDeleteWorktreeCommandId, title: localize2({ bundle: 'ash', key: 'git.deleteWorktreeCommandTitle' }, 'Git: Delete Worktree'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const targetRepositoryId = (await git.getRepository(repositoryId)).id;
			const worktrees = await git.worktrees(targetRepositoryId);
			const selected = await pickWorktree(accessor.get(IQuickInputService), worktrees, localize('git.selectWorktreeToDelete', 'Select a Git worktree to delete'));
			if (!selected) { return; }
			const confirmation = await accessor.get(IDialogService).confirm({
				title: localize('git.deleteWorktreeCommandTitle', 'Git: Delete Worktree'),
				message: localize('git.deleteWorktreeConfirm', 'Delete the worktree at {0}?', selected.checkoutRoot),
				detail: localize('git.deleteWorktreeDetail', 'Git only removes clean linked worktrees that are not held by a session or currently open in this workspace.'),
				primaryButton: localize('git.deleteWorktreeButton', 'Delete Worktree'),
			});
			if (!confirmation.confirmed) { return; }
			await git.deleteWorktree(selected.checkoutRoot, targetRepositoryId);
			notifications.info(localize('git.worktreeDeleted', 'Deleted worktree at {0}.', selected.checkoutRoot));
		} catch (error) {
			const reason = error instanceof AppServerRemoteError && error.errorName === 'GitOperationFailed'
				? localize('git.deleteWorktreeRejected', 'The worktree could not be deleted. Check local changes, locks and session ownership.')
				: gitErrorMessage(error);
			notifications.error(localize('git.deleteWorktreeFailed', 'Could not delete worktree: {0}', reason));
		}
	}
});

function pickWorktree(quickInput: IQuickInputService, worktrees: readonly GitWorktree[], label: string): Promise<GitWorktree | undefined> {
	const picker = quickInput.createQuickPick<WorktreeItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.ariaLabel = label;
	picker.placeholder = label;
	picker.items = worktrees.filter(worktree => worktree.state === 'ready' && !worktree.current).map(worktree => ({
		label: worktree.checkoutRoot,
		description: worktree.branch ?? localize('git.detachedWorktree', 'Detached HEAD'),
		detail: worktree.path,
		worktree,
	}));
	return new Promise(resolve => {
		let settled = false;
		const finish = (worktree: GitWorktree | undefined): void => {
			if (settled) { return; }
			settled = true;
			resolve(worktree);
			disposables.dispose();
		};
		disposables.add(picker.onDidAccept(item => finish(item.worktree)));
		disposables.add(picker.onDidHide(() => finish(undefined)));
		picker.show();
	});
}
