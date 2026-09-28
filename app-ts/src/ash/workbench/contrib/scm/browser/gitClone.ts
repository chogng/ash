import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IsNativeContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize } from '../../../../nls.js';
import { IGitService } from '../../../services/git/common/gitService.js';
import { IWorkspaceOpenService } from '../../../services/workspaces/browser/workspaceOpenService.js';

export const GitCloneCommandId = 'git.clone';

registerAction2(class GitCloneAction extends Action2 {
	constructor() {
		super({
			id: GitCloneCommandId,
			title: localize({ bundle: 'ash', key: 'git.cloneCommandTitle' }, 'Git: Clone Repository'),
			f1: true,
			precondition: IsNativeContext.isEqualTo(true),
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const gitService = accessor.get(IGitService);
		if (!gitService.canCloneRepository) throw new Error('Git clone is unavailable in this Workbench host');
		const workspaceOpenService = accessor.get(IWorkspaceOpenService);
		const url = await accessor.get(IQuickInputService).input({
			title: localize({ bundle: 'ash', key: 'git.cloneUrlTitle' }, 'Clone Repository'),
			placeHolder: localize({ bundle: 'ash', key: 'git.cloneUrlPlaceholder' }, 'Enter a repository URL'),
			validateInput: async value => value.trim()
				? undefined
				: localize({ bundle: 'ash', key: 'git.cloneUrlRequired' }, 'Enter a repository URL.'),
		});
		if (url === undefined) return;
		const parentPath = await workspaceOpenService.pickFolder();
		if (!parentPath) return;
		const notifications = accessor.get(INotificationService);
		const pending = notifications.info(localize({ bundle: 'ash', key: 'git.cloning' }, 'Cloning repository…'));
		let repositoryPath: string;
		try {
			repositoryPath = await gitService.cloneRepository(url.trim(), parentPath);
		} catch (error) {
			console.error('Could not clone repository', error);
			notifications.error(localize({ bundle: 'ash', key: 'git.cloneFailed' }, 'Could not clone repository. Check the URL and Git access, then try again.'));
			return;
		} finally {
			pending.close();
		}
		const open = await accessor.get(IDialogService).confirm({
			title: localize({ bundle: 'ash', key: 'git.cloneCompleteTitle' }, 'Repository cloned'),
			message: localize({ bundle: 'ash', key: 'git.cloneCompleteMessage' }, 'Open the cloned repository at {0}?', repositoryPath),
			primaryButton: localize({ bundle: 'ash', key: 'git.openClonedRepository' }, 'Open Repository'),
		});
		if (open.confirmed) await workspaceOpenService.openWorkspace(repositoryPath);
	}
});
