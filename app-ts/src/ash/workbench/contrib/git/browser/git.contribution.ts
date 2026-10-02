import { localizedString } from '../../../../platform/action/common/action.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { isEditorPaneWithSelection } from '../../../common/editor.js';
import { isDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import type { GitCommand, GitChangeFileComparison, GitIndexSelection, GitIndexDiff } from '../common/gitService.js';
import { gitErrorMessage } from '../common/gitError.js';
import './gitClone.js';
import './gitBranches.js';
import './gitWorktrees.js';
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

registerWorkbenchContribution('workbench.contrib.gitSCMProvider', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(GitSCMContribution,
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

const repositoryCommands: readonly { readonly kind: GitCommand['kind']; readonly id: string; readonly key: string; readonly title: string }[] = [
	{ kind: 'renameBranch', id: 'git.renameBranch', key: 'git.renameBranchTitle', title: 'Git: Rename Branch' },
	{ kind: 'deleteRemoteBranch', id: 'git.deleteRemoteBranch', key: 'git.deleteRemoteBranchTitle', title: 'Git: Delete Remote Branch' },
	{ kind: 'merge', id: 'git.merge', key: 'git.mergeBranchTitle', title: 'Git: Merge Branch' },
	{ kind: 'rebase', id: 'git.rebase', key: 'git.rebaseTitle', title: 'Git: Rebase Branch' },
	{ kind: 'cherryPick', id: 'git.cherryPick', key: 'git.cherryPickTitle', title: 'Git: Cherry-Pick Commit' },
	{ kind: 'continue', id: 'git.continue', key: 'git.continueTitle', title: 'Git: Continue Merge, Rebase or Cherry-Pick' },
	{ kind: 'abort', id: 'git.abort', key: 'git.abortTitle', title: 'Git: Abort Merge, Rebase or Cherry-Pick' },
	{ kind: 'stash', id: 'git.stash', key: 'git.stashTitle', title: 'Git: Stash Changes' },
	{ kind: 'applyStash', id: 'git.stashApply', key: 'git.stashApplyTitle', title: 'Git: Apply Stash' },
	{ kind: 'popStash', id: 'git.stashPop', key: 'git.stashPopTitle', title: 'Git: Pop Stash' },
	{ kind: 'dropStash', id: 'git.stashDrop', key: 'git.stashDropTitle', title: 'Git: Delete Stash' },
	{ kind: 'createTag', id: 'git.createTag', key: 'git.createTagTitle', title: 'Git: Create Tag' },
	{ kind: 'deleteTag', id: 'git.deleteTag', key: 'git.deleteTagTitle', title: 'Git: Delete Tag' },
	{ kind: 'addRemote', id: 'git.addRemote', key: 'git.addRemoteTitle', title: 'Git: Add Remote' },
	{ kind: 'removeRemote', id: 'git.removeRemote', key: 'git.removeRemoteTitle', title: 'Git: Remove Remote' },
	{ kind: 'amend', id: 'git.commitAmend', key: 'git.amendTitle', title: 'Git: Amend Last Commit' },
	{ kind: 'undoCommit', id: 'git.undoCommit', key: 'git.undoCommitTitle', title: 'Git: Undo Last Commit' },
];

for (const definition of repositoryCommands) {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: definition.id, title: localizedString('ash', definition.key, definition.title), f1: true });
		}

		public override async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
			const notifications = accessor.get(INotificationService);
			try {
				const git = accessor.get(IGitService);
				const target = (await git.getRepository(repositoryId)).id;
				const command = await prepareGitCommand(accessor, definition.kind, target);
				if (!command) { return; }
				const result = await git.executeCommand(command, target);
				if (result.outcome === 'conflicted') {
					notifications.warning(result.operation
						? localize('git.integrationConflicts', 'Git stopped on conflicts. Resolve the files in Source Control, then run Git: Continue. Use Git: Abort to cancel an integration.')
						: localize('git.stashConflicts', 'The stash has conflicts. Resolve the files in Source Control. The stash is kept until you delete it.'));
				} else {
					notifications.info(localize('git.commandCompleted', 'Git operation completed.'));
				}
			} catch (error) {
				notifications.error(localize('git.commandFailed', 'Git operation failed: {0}', gitErrorMessage(error)));
			}
		}
	});
}

async function prepareGitCommand(accessor: ServicesAccessor, kind: GitCommand['kind'], repositoryId: string): Promise<GitCommand | undefined> {
	const git = accessor.get(IGitService);
	const input = accessor.get(IQuickInputService);
	const prompt = (placeHolder: string, value?: string) => input.input({
		placeHolder, value,
		validateInput: async text => text.trim() ? undefined : localize('git.valueRequired', 'Enter a value.'),
	});
	const confirm = async (message: string) => (await accessor.get(IDialogService).confirm({
		title: localize('git.confirmOperation', 'Confirm Git Operation'), message,
		primaryButton: localize('git.confirmOperationButton', 'Continue'),
	})).confirmed;

	switch (kind) {
		case 'renameBranch': {
			const branches = await git.branches(repositoryId);
			const branch = await pickGitItem(input, branches.map(branch => ({ label: branch.name, branch })), localize('git.chooseBranch', 'Choose a branch'));
			if (!branch) { return undefined; }
			const name = await prompt(localize('git.renameBranchName', 'New branch name'), branch.branch.name);
			return name === undefined ? undefined : { kind, name: branch.branch.name, newName: name.trim() };
		}
		case 'deleteRemoteBranch': {
			const graph = await git.graph({ limit: 1 }, repositoryId);
			const branches = graph.references.filter(reference => reference.kind === 'remoteBranch' && reference.remoteName);
			const selected = await pickGitItem(input, branches.map(reference => ({ label: reference.name, reference })), localize('git.chooseRemoteBranch', 'Choose a remote branch to delete'));
			if (!selected?.reference.remoteName) { return undefined; }
			const remote = selected.reference.remoteName;
			const name = selected.reference.name.slice(remote.length + 1);
			if (!await confirm(localize('git.deleteRemoteBranchConfirm', 'Delete branch {0} from remote {1}?', name, remote))) { return undefined; }
			return { kind, remote, name };
		}
		case 'merge':
		case 'rebase': {
			const graph = await git.graph({ limit: 1 }, repositoryId);
			const selected = await pickGitItem(input, graph.references.filter(reference => !reference.current).map(reference => ({ label: reference.name, reference })), localize('git.chooseIntegrationRef', 'Choose the branch to integrate'));
			return selected ? { kind, reference: selected.reference.objectId } : undefined;
		}
		case 'cherryPick': {
			const graph = await git.graph({ limit: 200 }, repositoryId);
			const selected = await pickGitItem(input, graph.commits.map(commit => ({ label: commit.subject, description: commit.objectId.slice(0, 8), commit })), localize('git.chooseCommit', 'Choose a commit'));
			return selected ? { kind, reference: selected.commit.objectId } : undefined;
		}
		case 'continue':
		case 'abort': {
			const operation = (await git.catalog(repositoryId)).operation;
			if (!operation) {
				accessor.get(INotificationService).info(localize('git.noIntegration', 'No merge, rebase or cherry-pick is in progress.'));
				return undefined;
			}
			if (kind === 'abort' && !await confirm(localize('git.abortConfirm', 'Abort the current integration and restore its starting state?'))) { return undefined; }
			return { kind, operation };
		}
		case 'stash': {
			const message = await prompt(localize('git.stashMessage', 'Stash message'));
			if (message === undefined) { return undefined; }
			const mode = await pickGitItem(input, [
				{ label: localize('git.stashTracked', 'Tracked changes'), mode: 'tracked' as const },
				{ label: localize('git.stashUntracked', 'Tracked and untracked changes'), mode: 'includeUntracked' as const },
			], localize('git.stashScope', 'Choose changes to stash'));
			return mode ? { kind, message, mode: mode.mode } : undefined;
		}
		case 'applyStash':
		case 'popStash':
		case 'dropStash': {
			const catalog = await git.catalog(repositoryId);
			const selected = await pickGitItem(input, catalog.stashes.map(stash => ({ label: stash.subject, description: stash.objectId.slice(0, 8), stash })), localize('git.chooseStash', 'Choose a stash'));
			if (!selected) { return undefined; }
			if (kind === 'dropStash' && !await confirm(localize('git.dropStashConfirm', 'Delete stash {0}?', selected.stash.subject))) { return undefined; }
			return { kind, objectId: selected.stash.objectId };
		}
		case 'createTag': {
			const name = await prompt(localize('git.tagName', 'Tag name'));
			if (name === undefined) { return undefined; }
			const reference = await prompt(localize('git.tagReference', 'Commit or reference to tag'), 'HEAD');
			return reference === undefined ? undefined : { kind, name: name.trim(), reference: reference.trim() };
		}
		case 'deleteTag': {
			const catalog = await git.catalog(repositoryId);
			const selected = await pickGitItem(input, catalog.tags.map(tag => ({ label: tag.name, tag })), localize('git.chooseTag', 'Choose a tag'));
			if (!selected || !await confirm(localize('git.deleteTagConfirm', 'Delete tag {0}?', selected.tag.name))) { return undefined; }
			return { kind, name: selected.tag.name };
		}
		case 'addRemote': {
			const name = await prompt(localize('git.remoteName', 'Remote name'));
			if (name === undefined) { return undefined; }
			const url = await prompt(localize('git.remoteUrl', 'Remote repository URL'));
			return url === undefined ? undefined : { kind, name: name.trim(), url: url.trim() };
		}
		case 'removeRemote': {
			const catalog = await git.catalog(repositoryId);
			const selected = await pickGitItem(input, catalog.remotes.map(name => ({ label: name })), localize('git.chooseRemote', 'Choose a remote'));
			if (!selected || !await confirm(localize('git.removeRemoteConfirm', 'Remove remote {0}?', selected.label))) { return undefined; }
			return { kind, name: selected.label };
		}
		case 'amend': {
			const message = await prompt(localize('git.amendMessage', 'Replacement commit message'));
			if (message === undefined || !await confirm(localize('git.amendConfirm', 'Replace the last commit with the current staged changes and this message? This rewrites commit history.'))) { return undefined; }
			return { kind, message };
		}
		case 'undoCommit': {
			const status = await git.status(repositoryId);
			if (status.head.type === 'unborn') { return undefined; }
			if (!await confirm(localize('git.undoCommitConfirm', 'Undo commit {0} and keep its changes staged? This rewrites commit history.', status.head.objectId.slice(0, 8)))) { return undefined; }
			return { kind, expectedHead: status.head.objectId };
		}
	}
}

/** The picker owns every listener until acceptance or cancellation. */
async function pickGitItem<T extends IQuickPickItem>(input: IQuickInputService, items: readonly T[], placeHolder: string): Promise<T | undefined> {
	if (items.length === 0) { return undefined; }
	using lifetime = new DisposableStore();
	const picker = lifetime.add(input.createQuickPick<T>());
	picker.items = items;
	picker.placeholder = placeHolder;
	picker.ariaLabel = placeHolder;
	return await new Promise<T | undefined>(resolve => {
		lifetime.add(picker.onDidAccept(item => { resolve(item); picker.hide(); }));
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}

registerAction2(class GitInitAction extends Action2 {
	constructor() {
		super({ id: 'git.init', title: localizedString('ash', 'git.initTitle', 'Git: Initialize Repository'), f1: true });
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		try {
			await accessor.get(IGitService).listRepositories();
			const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
			const folder = await pickGitItem(accessor.get(IQuickInputService), folders.map(folder => ({ label: folder.name, folder })), localize('git.initFolder', 'Choose a workspace folder to initialize'));
			if (!folder) { return; }
			const branch = await accessor.get(IQuickInputService).input({ value: 'main', placeHolder: localize('git.initBranch', 'Initial branch name') });
			if (branch === undefined) { return; }
			await accessor.get(IGitService).initializeRepository(branch.trim(), folder.folder.id);
			accessor.get(INotificationService).info(localize('git.initialized', 'Git repository initialized.'));
		} catch (error) {
			accessor.get(INotificationService).error(localize('git.commandFailed', 'Git operation failed: {0}', gitErrorMessage(error)));
		}
	}
});

for (const definition of [
	{ id: 'git.stageHunk', key: 'git.stageHunkTitle', title: 'Git: Stage Change Block', comparison: 'unstaged', selection: 'hunk' },
	{ id: 'git.unstageHunk', key: 'git.unstageHunkTitle', title: 'Git: Unstage Change Block', comparison: 'staged', selection: 'hunk' },
	{ id: 'git.stageSelectedRanges', key: 'git.stageSelectionTitle', title: 'Git: Stage Selected Lines', comparison: 'unstaged', selection: 'lines' },
	{ id: 'git.unstageSelectedRanges', key: 'git.unstageSelectionTitle', title: 'Git: Unstage Selected Lines', comparison: 'staged', selection: 'lines' },
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: definition.id, title: localizedString('ash', definition.key, definition.title), f1: true });
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			try {
				await runIndexSelection(accessor, definition.comparison, definition.selection);
			} catch (error) {
				accessor.get(INotificationService).error(localize('git.commandFailed', 'Git operation failed: {0}', gitErrorMessage(error)));
			}
		}
	});
}

async function runIndexSelection(accessor: ServicesAccessor, comparison: GitChangeFileComparison, mode: 'hunk' | 'lines'): Promise<void> {
	const git = accessor.get(IGitService);
	const input = accessor.get(IQuickInputService);
	const repository = await git.getRepository();
	const status = await git.status(repository.id);
	let path: string;
	let selection: GitIndexSelection;
	let reviewed: GitIndexDiff;
	if (mode === 'lines') {
		const part = accessor.get(IEditorPart);
		const editor = part.activeInput;
		const pane = part.activePane;
		const range = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
		if (!editor || !range) { throw new Error(localize('git.selectText', 'Select lines in a file or Git comparison editor.')); }
		if (isDiffEditorInput(editor)) {
			const resource = editor.modified.resource;
			const query = new URLSearchParams(resource.query);
			if (resource.scheme !== 'git-change' || !resource.path.startsWith(`/${comparison}/`) || query.get('stream') !== status.streamInstanceId || query.get('revision') !== String(status.revision)) {
				throw new Error(localize('git.reopenComparison', 'Open the current comparison from Source Control before selecting lines.'));
			}
			path = resource.path.slice(comparison.length + 2).split('/').map(decodeURIComponent).join('/');
		} else {
			const relative = extUriBiasedIgnorePathCase.isEqualOrParent(editor.resource, repository.root)
				? editor.resource.path.slice(repository.root.path.replace(/\/$/, '').length + 1)
				: undefined;
			if (comparison !== 'unstaged' || relative === undefined) { throw new Error(localize('git.reopenComparison', 'Open the current comparison from Source Control before selecting lines.')); }
			path = relative;
			if (pane?.workingCopy?.isDirty) {
				const answer = await accessor.get(IDialogService).confirm({ message: localize('git.saveBeforeStage', 'Save this file before staging its selected lines?'), primaryButton: localize('git.saveBeforeStageButton', 'Save and Stage') });
				if (!answer.confirmed) { return; }
				await pane.workingCopy.save(new AbortController().signal);
			}
		}
		selection = { kind: 'lines', start: range.startLineNumber, end: range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber };
		reviewed = await git.indexDiff(path, comparison, repository.id);
	} else {
		const changes = status.changes.filter(change => !change.conflicted && (comparison === 'staged' ? change.indexStatus !== 'unmodified' : change.worktreeStatus !== 'unmodified'));
		const file = await pickGitItem(input, changes.map(change => ({ label: change.path })), localize('git.choosePartialFile', 'Choose a file for partial staging'));
		if (!file) { return; }
		path = file.label;
		reviewed = await git.indexDiff(path, comparison, repository.id);
		const hunk = await pickGitItem(input, reviewed.hunks.map(hunk => ({ label: localize('git.hunkLines', 'Lines {0}–{1}', hunk.newStart, Math.max(hunk.newStart, hunk.newStart + hunk.newCount - 1)), detail: hunk.preview, hunk })), localize('git.chooseHunk', 'Choose a change block'));
		if (!hunk) { return; }
		selection = { kind: 'hunk', index: hunk.hunk.index };
	}
	await git.editIndex(path, comparison, reviewed, selection, repository.id);
	accessor.get(INotificationService).info(localize('git.indexEdited', 'Selected changes updated in the index.'));
}
