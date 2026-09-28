import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AppServerRemoteError } from '../../../../platform/app-server/common/appServerError.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type GitBranch, IGitService } from '../../../services/git/common/gitService.js';
import { GitSwitchBranchCommandId } from '../common/gitCommands.js';
import { gitErrorMessage } from '../common/gitError.js';

interface BranchItem extends IQuickPickItem {
	readonly branch: GitBranch;
}

registerAction2(class GitSwitchBranchAction extends Action2 {
	constructor() {
		super({
			id: GitSwitchBranchCommandId,
			title: localize({ bundle: 'ash', key: 'git.switchBranchCommandTitle' }, 'Git: Switch Branch'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		const git = accessor.get(IGitService);
		const notifications = accessor.get(INotificationService);
		try {
			const branches = await git.branches(repositoryId);
			const targetRepositoryId = repositoryId ?? git.activeRepository?.id;
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

function pickBranch(quickInput: IQuickInputService, branches: readonly GitBranch[]): Promise<GitBranch | undefined> {
	const picker = quickInput.createQuickPick<BranchItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.ariaLabel = localize({ bundle: 'ash', key: 'git.selectBranch' }, 'Select a Git branch');
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
