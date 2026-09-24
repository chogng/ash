import type { Icon } from '../../../../base/common/icon.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IGitService, type GitStatus } from '../../../services/git/common/gitService.js';

export const GIT_GRAPH_VIEW_ID = 'ash.gitGraph';
export const GitGraphBusyContext = new RawContextKey<boolean>('gitGraphBusy', false);

const GitFetchCommandId = 'ash.git.fetch';
const GitPullCommandId = 'ash.git.pull';
const GitPushCommandId = 'ash.git.push';
const GitGraphRefreshCommandId = 'ash.git.graph.refresh';

interface GitGraphActionTarget {
	readonly repositoryId: string | undefined;
	runTitleOperation(operation?: () => Promise<unknown>): Promise<void>;
}

abstract class GitGraphAction extends Action2 {
	protected constructor(id: string, title: string, tooltip: string, icon: Icon, order: number) {
		super({
			id,
			title,
			tooltip,
			icon,
			precondition: GitGraphBusyContext.isEqualTo(false),
			menu: { id: MenuId.GitGraphTitle, group: 'navigation', order },
		});
	}

	protected runRemote(accessor: ServicesAccessor, target: unknown, operation: (gitService: IGitService, repositoryId?: string) => Promise<GitStatus>): Promise<void> {
		const gitService = accessor.get(IGitService);
		const repositoryId = isGitGraphActionTarget(target) ? target.repositoryId : undefined;
		return runInGraph(target, () => operation(gitService, repositoryId));
	}
}

registerAction2(class GitFetchAction extends GitGraphAction {
	constructor() { super(GitFetchCommandId, 'Fetch', 'Fetch Git remotes', lxiconsLibrary.repoFetch, 1); }
	override run(accessor: ServicesAccessor, target: unknown): Promise<void> { return this.runRemote(accessor, target, (gitService, repositoryId) => gitService.fetch(repositoryId)); }
});

registerAction2(class GitPullAction extends GitGraphAction {
	constructor() { super(GitPullCommandId, 'Pull', 'Pull current branch (fast-forward only)', lxiconsLibrary.repoPull, 2); }
	override run(accessor: ServicesAccessor, target: unknown): Promise<void> { return this.runRemote(accessor, target, (gitService, repositoryId) => gitService.pull(repositoryId)); }
});

registerAction2(class GitPushAction extends GitGraphAction {
	constructor() { super(GitPushCommandId, 'Push', 'Push current branch', lxiconsLibrary.repoPush, 3); }
	override run(accessor: ServicesAccessor, target: unknown): Promise<void> { return this.runRemote(accessor, target, (gitService, repositoryId) => gitService.push(repositoryId)); }
});

registerAction2(class GitGraphRefreshAction extends GitGraphAction {
	constructor() { super(GitGraphRefreshCommandId, 'Refresh', 'Refresh Git graph', lxiconsLibrary.refresh, 4); }
	override run(_accessor: ServicesAccessor, target: unknown): Promise<void> { return runInGraph(target); }
});

async function runInGraph(target: unknown, operation?: () => Promise<unknown>): Promise<void> {
	if (isGitGraphActionTarget(target)) {
		await target.runTitleOperation(operation);
		return;
	}
	await operation?.();
}

function isGitGraphActionTarget(value: unknown): value is GitGraphActionTarget {
	return typeof value === 'object' && value !== null &&
		(typeof (value as GitGraphActionTarget).repositoryId === 'string' || (value as GitGraphActionTarget).repositoryId === undefined) &&
		typeof (value as GitGraphActionTarget).runTitleOperation === 'function';
}
