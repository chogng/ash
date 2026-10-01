import './gitClone.js';
import './gitBranches.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IDecorationsService, type IDecorationData, type IDecorationsProvider } from '../../../services/decorations/common/decorations.js';
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

const ignoredResourceForeground = registerColor('gitDecoration.ignoredResourceForeground', {
	dark: '#8c8c8c', light: '#767676', highContrastDark: foreground, highContrastLight: foreground,
}, { description: 'Foreground color for files ignored by Git.', owner: 'git.decorations' });

interface IgnoreQuery {
	readonly resource: URI;
	resolve(data: IDecorationData | undefined): void;
	reject(error: unknown): void;
}

class GitIgnoreDecorationProvider extends Disposable implements IDecorationsProvider {
	public readonly label = 'Git Ignore';
	private readonly changed = this._register(new Emitter<readonly URI[]>());
	public readonly onDidChange = this.changed.event;
	private readonly pending = new Map<symbol, IgnoreQuery>();
	private readonly requests = this._register(new DisposableMap<symbol, DisposableStore>());
	private readonly scheduler = this._register(new RunOnceScheduler(() => { void this.flush(); }, 0));

	constructor(
		@IGitService private readonly gitService: IGitService,
		@IFileService fileService: IFileService,
		@IDecorationsService decorationsService: IDecorationsService,
	) {
		super();
		this._register(gitService.onDidChangeRepositories(() => this.changed.fire([])));
		this._register(gitService.onDidChangeRepositoryStatus(() => this.changed.fire([])));
		this._register(fileService.onDidChangeFiles(() => this.changed.fire([])));
		this._register(onDidChangeNls(() => this.changed.fire([])));
		this._register(decorationsService.registerDecorationsProvider(this));
	}

	public provideDecorations(resource: URI, token: CancellationToken): Promise<IDecorationData | undefined> | undefined {
		const repository = this.gitService.repositoryForResource(resource);
		if (!repository || extUriBiasedIgnorePathCase.isEqual(resource, repository.root)) {
			return undefined;
		}
		const id = Symbol();
		const lifetime = this.requests.set(id, new DisposableStore());
		const result = new Promise<IDecorationData | undefined>((resolve, reject) => {
			this.pending.set(id, { resource, resolve, reject });
			lifetime.add(toDisposable(() => {
				this.pending.delete(id);
				reject(new CancellationError());
			}));
			lifetime.add(token.onCancellationRequested(() => this.requests.deleteAndDispose(id)));
			this.scheduler.schedule();
		});
		return result.finally(() => this.requests.deleteAndDispose(id));
	}

	private async flush(): Promise<void> {
		const queries = [...this.pending.values()];
		this.pending.clear();
		try {
			const ignored = await this.gitService.checkIgnore(queries.map(query => query.resource));
			const keys = new Set(ignored.map(resource => extUriBiasedIgnorePathCase.getComparisonKey(resource)));
			for (const query of queries) {
				query.resolve(keys.has(extUriBiasedIgnorePathCase.getComparisonKey(query.resource))
					? { color: ignoredResourceForeground, tooltip: localize('git.ignored', 'Ignored by Git') }
					: undefined);
			}
		} catch (error) {
			for (const query of queries) {
				query.reject(error);
			}
		}
	}
}

registerWorkbenchContribution('workbench.contrib.gitIgnoreDecorations', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(GitIgnoreDecorationProvider));

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
