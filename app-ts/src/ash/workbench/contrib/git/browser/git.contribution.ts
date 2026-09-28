import './gitClone.js';
import './gitBranches.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { ISCMService, ISCMViewService, SCMHistoryBusyContext, SCMHistoryProviderIdContext } from '../../scm/common/scm.js';
import { IQuickDiffService } from '../../scm/common/quickDiff.js';
import { IGitService, type GitStatus } from '../common/gitService.js';
import { GitQuickDiffProvider } from './gitQuickDiffProvider.js';
import { GitSCMContribution } from './gitSCMProvider.js';

registerWorkbenchContribution('workbench.contrib.gitSCMProvider', WorkbenchPhase.BlockRestore, accessor => new GitSCMContribution(
	accessor.get(IGitService),
	accessor.get(ISCMService),
	accessor.get(ISCMViewService),
	{
		commandService: accessor.get(ICommandService),
		dialogService: accessor.get(IDialogService),
		editorService: accessor.get(IEditorService),
		viewsService: accessor.get(IViewsService),
		workingCopyService: accessor.get(IWorkingCopyService),
	},
));

registerWorkbenchContribution('workbench.contrib.gitQuickDiffProvider', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	const provider = resources.add(new GitQuickDiffProvider(accessor.get(IGitService)));
	resources.add(accessor.get(IQuickDiffService).addProvider(provider));
	return resources;
});

interface GitHistoryActionTarget {
	readonly repositoryId: string | undefined;
	runTitleOperation(operation?: () => Promise<unknown>): Promise<void>;
}

abstract class GitHistoryAction extends Action2 {
	protected constructor(id: string, title: string, tooltip: string, icon: Icon, order: number) {
		super({
			id,
			title,
			tooltip,
			icon,
			precondition: SCMHistoryBusyContext.isEqualTo(false),
			menu: { id: MenuId.SCMHistoryTitle, when: SCMHistoryProviderIdContext.isEqualTo('git'), group: 'navigation', order },
		});
	}

	protected async runRemote(accessor: ServicesAccessor, target: unknown, operation: (gitService: IGitService, repositoryId?: string) => Promise<GitStatus>): Promise<void> {
		const gitService = accessor.get(IGitService);
		const repositoryId = isGitHistoryActionTarget(target) ? target.repositoryId : undefined;
		const run = () => operation(gitService, repositoryId);
		if (isGitHistoryActionTarget(target)) {
			await target.runTitleOperation(run);
			return;
		}
		await run();
	}
}

registerAction2(class GitFetchAction extends GitHistoryAction {
	constructor() {
		super('ash.git.fetch', 'Fetch', 'Fetch Git remotes', Lxicon.repoFetch, 1);
	}
	override run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		return this.runRemote(accessor, target, (gitService, repositoryId) => gitService.fetch(repositoryId));
	}
});

registerAction2(class GitPullAction extends GitHistoryAction {
	constructor() {
		super('ash.git.pull', 'Pull', 'Pull current branch (fast-forward only)', Lxicon.repoPull, 2);
	}
	override run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		return this.runRemote(accessor, target, (gitService, repositoryId) => gitService.pull(repositoryId));
	}
});

registerAction2(class GitPushAction extends GitHistoryAction {
	constructor() {
		super('ash.git.push', 'Push', 'Push current branch', Lxicon.repoPush, 3);
	}
	override run(accessor: ServicesAccessor, target: unknown): Promise<void> {
		return this.runRemote(accessor, target, (gitService, repositoryId) => gitService.push(repositoryId));
	}
});

function isGitHistoryActionTarget(value: unknown): value is GitHistoryActionTarget {
	return typeof value === 'object' && value !== null &&
		(typeof (value as GitHistoryActionTarget).repositoryId === 'string' || (value as GitHistoryActionTarget).repositoryId === undefined) &&
		typeof (value as GitHistoryActionTarget).runTitleOperation === 'function';
}
