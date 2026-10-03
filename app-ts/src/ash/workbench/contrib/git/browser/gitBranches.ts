import { localize2, localize } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

import { AppServerRemoteError } from '../../../../platform/app-server/common/appServerError.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type GitBranch, IGitService } from '../common/gitService.js';
import { GitCreateBranchCommandId, GitDeleteBranchCommandId, GitSwitchBranchCommandId } from '../common/gitCommands.js';
import { gitErrorMessage } from '../common/gitError.js';

interface BranchItem extends IQuickPickItem {
	readonly branch: GitBranch;
}

registerAction2(class GitSwitchBranchAction extends Action2 {
	constructor() {
		super({
			id: GitSwitchBranchCommandId,
			title: localize2({ bundle: 'ash', key: 'git.switchBranchCommandTitle' }, 'Git: Switch Branch'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const targetRepositoryId = (await git.getRepository(repositoryId)).id;
			const branches = await git.branches(targetRepositoryId);
			if (branches.length === 0) {
				notifications.info(localize({ bundle: 'ash', key: 'git.noBranches' }, 'This repository has no branches to switch to.'));
				return;
			}
			const selected = await pickBranch(accessor.get(IQuickInputService), branches);
			if (!selected || selected.current) return;
			await git.switchBranch(selected.name, targetRepositoryId);
		} catch (error) {
			const reason = error instanceof AppServerRemoteError && error.errorName === 'GitOperationFailed'
				? localize({ bundle: 'ash', key: 'git.switchBranchRejected' }, 'Git rejected the switch. Check local changes and worktrees.')
				: gitErrorMessage(error);
			notifications.error(localize({ bundle: 'ash', key: 'git.switchBranchFailed' }, 'Could not switch branch: {0}', reason));
		}
	}
});

registerAction2(class GitCreateBranchAction extends Action2 {
	constructor() {
		super({ id: GitCreateBranchCommandId, title: localize2({ bundle: 'ash', key: 'git.createBranchCommandTitle' }, 'Git: Create Branch'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const targetRepositoryId = (await git.getRepository(repositoryId)).id;
			const branches = await git.branches(targetRepositoryId);
			const name = await accessor.get(IQuickInputService).input({
				title: localize('git.createBranchCommandTitle', 'Git: Create Branch'),
				placeHolder: localize('git.newBranchName', 'Name of the new branch at HEAD'),
				validateInput: async value => {
					if (!value.trim()) { return localize('git.branchNameRequired', 'Enter a branch name.'); }
					if (branches.some(branch => branch.name === value.trim())) { return localize('git.branchAlreadyExists', 'This branch already exists.'); }
					return undefined;
				},
			});
			if (name === undefined) { return; }
			await git.createBranch(name.trim(), targetRepositoryId);
			notifications.info(localize('git.branchCreated', 'Created branch {0}. The current branch is unchanged.', name.trim()));
		} catch (error) {
			notifications.error(localize('git.createBranchFailed', 'Could not create branch: {0}', gitErrorMessage(error)));
		}
	}
});

registerAction2(class GitDeleteBranchAction extends Action2 {
	constructor() {
		super({ id: GitDeleteBranchCommandId, title: localize2({ bundle: 'ash', key: 'git.deleteBranchCommandTitle' }, 'Git: Delete Branch'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const targetRepositoryId = (await git.getRepository(repositoryId)).id;
			const branches = (await git.branches(targetRepositoryId)).filter(branch => !branch.current);
			if (branches.length === 0) {
				notifications.info(localize('git.noBranchesToDelete', 'There are no other local branches to delete.'));
				return;
			}
			const selected = await pickBranch(accessor.get(IQuickInputService), branches, localize('git.selectBranchToDelete', 'Select a Git branch to delete'));
			if (!selected) { return; }
			const confirmation = await accessor.get(IDialogService).confirm({
				title: localize('git.deleteBranchCommandTitle', 'Git: Delete Branch'),
				message: localize('git.deleteBranchConfirm', 'Delete local branch {0}?', selected.name),
				detail: localize('git.deleteBranchDetail', 'Git only deletes merged branches that are not checked out in any worktree.'),
				primaryButton: localize('git.deleteBranchButton', 'Delete Branch'),
			});
			if (!confirmation.confirmed) { return; }
			await git.deleteBranch(selected.name, targetRepositoryId);
			notifications.info(localize('git.branchDeleted', 'Deleted branch {0}.', selected.name));
		} catch (error) {
			const reason = error instanceof AppServerRemoteError && error.errorName === 'GitOperationFailed'
				? localize('git.deleteBranchRejected', 'Git rejected the deletion. Check unmerged commits and worktrees.')
				: gitErrorMessage(error);
			notifications.error(localize('git.deleteBranchFailed', 'Could not delete branch: {0}', reason));
		}
	}
});

function pickBranch(quickInput: IQuickInputService, branches: readonly GitBranch[], label = localize({ bundle: 'ash', key: 'git.selectBranch' }, 'Select a Git branch')): Promise<GitBranch | undefined> {
	const picker = quickInput.createQuickPick<BranchItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.ariaLabel = label;
	picker.placeholder = picker.ariaLabel;
	picker.items = branches.map(branch => ({
		label: branch.name,
		description: branch.current ? localize({ bundle: 'ash', key: 'git.currentBranch' }, 'Current') : branch.upstream,
		branch,
	}));
	return new Promise(resolve => {
		let settled = false;
		const finish = (branch: GitBranch | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(branch);
			disposables.dispose();
		};
		disposables.add(picker.onDidAccept(item => finish(item.branch)));
		disposables.add(picker.onDidHide(() => finish(undefined)));
		picker.show();
	});
}
