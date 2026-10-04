import { localize2, localize } from '../../../../nls.js';

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
import { URI } from '../../../../base/common/uri.js';

import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/openerService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { SCMHistoryItemViewModelTreeElement, ISCMHistoryItemComparison, ISCMHistoryItemRef } from '../../scm/common/history.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IDecorationsService, type IDecorationData, type IDecorationsProvider } from '../../../services/decorations/common/decorations.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
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

type RepositoryCommandKind = Exclude<GitCommand['kind'], 'createBranchAt' | 'checkoutDetached' | 'checkoutRemoteBranch'>;

const repositoryCommands: readonly { readonly kind: RepositoryCommandKind; readonly id: string; readonly key: string; readonly title: string }[] = [
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
			super({ id: definition.id, title: localize2({ bundle: 'ash', key: definition.key }, definition.title), f1: true });
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

async function prepareGitCommand(accessor: ServicesAccessor, kind: RepositoryCommandKind, repositoryId: string): Promise<GitCommand | undefined> {
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
		super({ id: 'git.init', title: localize2({ bundle: 'ash', key: 'git.initTitle' }, 'Git: Initialize Repository'), f1: true });
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
			super({ id: definition.id, title: localize2({ bundle: 'ash', key: definition.key }, definition.title), f1: true });
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

const graphCheckoutMenu = MenuId.for('SCMHistoryItemCheckout');
const graphMoreMenu = MenuId.for('SCMHistoryItemMore');
const graphRefMenu = MenuId.for('SCMHistoryItemRefContext');
const gitGraphWhen = SCMHistoryProviderIdContext.isEqualTo('git');

// SCM's inline Open Changes action leads the context menu; Git groups follow it.
MenusRegistry.appendMenuItem(MenuId.SCMHistoryItemContext, { submenu: graphCheckoutMenu, title: localize2('git.graph.checkout', 'Checkout'), group: 'scm_2_checkout', when: gitGraphWhen });
MenusRegistry.appendMenuItem(MenuId.SCMHistoryItemContext, { submenu: graphMoreMenu, title: localize2('git.graph.more', 'More…'), group: 'scm_4_more', when: gitGraphWhen });

type GraphActionKind = 'openRemote' | 'checkoutBranch' | 'checkoutDetached' | 'createBranch' | 'deleteBranch' | 'createTag' | 'cherryPick' | 'compareRemote' | 'compareMergeBase' | 'compare' | 'copyHash' | 'copyMessage';

const graphActions: readonly { kind: GraphActionKind; title: ReturnType<typeof localize2>; menu: MenuId; group: string; order: number; when?: ReturnType<typeof ContextKeyExpr.has> }[] = [
	{ kind: 'openRemote', title: localize2('git.graph.openRemote', 'Open Commit in Browser'), menu: MenuId.SCMHistoryItemContext, group: 'scm_0_open', order: 1, when: ContextKeyExpr.has('scmHistoryItemHasRemote') },
	{ kind: 'compare', title: localize2('git.graph.compare', 'Compare with…'), menu: MenuId.SCMHistoryItemContext, group: 'scm_1_compare', order: 1 },
	{ kind: 'compareRemote', title: localize2('git.graph.compareRemote', 'Compare with Remote…'), menu: MenuId.SCMHistoryItemContext, group: 'scm_1_compare', order: 2, when: ContextKeyExpr.has('scmHistoryItemHasUpstream') },
	{ kind: 'compareMergeBase', title: localize2('git.graph.compareMergeBase', 'Compare with Merge Base…'), menu: MenuId.SCMHistoryItemContext, group: 'scm_1_compare', order: 3 },
	{ kind: 'checkoutBranch', title: localize2('git.graph.checkoutBranch', 'Switch to Branch…'), menu: graphCheckoutMenu, group: '1_branch', order: 1, when: ContextKeyExpr.has('scmHistoryItemHasBranch') },
	{ kind: 'checkoutDetached', title: localize2('git.graph.checkoutDetached', 'Checkout Commit (Detached)'), menu: graphCheckoutMenu, group: '2_commit', order: 1 },
	{ kind: 'createBranch', title: localize2('git.graph.createBranch', 'Create Branch…'), menu: MenuId.SCMHistoryItemContext, group: 'scm_3_edit', order: 1 },
	{ kind: 'cherryPick', title: localize2('git.graph.cherryPick', 'Cherry Pick'), menu: MenuId.SCMHistoryItemContext, group: 'scm_3_edit', order: 2 },
	{ kind: 'createTag', title: localize2('git.graph.createTag', 'Create Tag…'), menu: graphMoreMenu, group: '1_tag', order: 1 },
	{ kind: 'copyHash', title: localize2('git.graph.copyHash', 'Copy Commit Hash'), menu: MenuId.SCMHistoryItemContext, group: 'scm_5_copy', order: 1 },
	{ kind: 'copyMessage', title: localize2('git.graph.copyMessage', 'Copy Commit Message'), menu: MenuId.SCMHistoryItemContext, group: 'scm_5_copy', order: 2 },
	{ kind: 'copyHash', title: localize2('git.graph.copyHash', 'Copy Commit Hash'), menu: MenuId.for('SCMHistoryItemHover'), group: 'inline', order: 1 },
	{ kind: 'checkoutBranch', title: localize2('git.graph.checkoutBranch', 'Switch to Branch…'), menu: graphRefMenu, group: '1_branch', order: 1, when: ContextKeyExpr.has('scmHistoryItemHasBranch') },
	{ kind: 'deleteBranch', title: localize2('git.graph.deleteBranch', 'Delete Branch…'), menu: graphRefMenu, group: '2_delete', order: 1, when: ContextKeyExpr.has('scmHistoryRefCanDelete') },
	{ kind: 'compareRemote', title: localize2('git.graph.compareRemote', 'Compare with Remote…'), menu: graphRefMenu, group: '3_compare', order: 1, when: ContextKeyExpr.has('scmHistoryItemHasUpstream') },
	{ kind: 'compareMergeBase', title: localize2('git.graph.compareMergeBase', 'Compare with Merge Base…'), menu: graphRefMenu, group: '3_compare', order: 2 },
	{ kind: 'compare', title: localize2('git.graph.compare', 'Compare with…'), menu: graphRefMenu, group: '3_compare', order: 3 },
];

for (const kind of new Set(graphActions.map(action => action.kind))) {
	const entries = graphActions.filter(action => action.kind === kind);
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: `git.graph.${kind}`, title: entries[0].title, icon: kind === 'copyHash' ? Lxicon.copy : undefined, shortTitle: kind === 'copyHash' ? { value: '', original: '' } : undefined, tooltip: entries[0].title, menu: entries.map(entry => ({ id: entry.menu, group: entry.group, order: entry.order, when: ContextKeyExpr.and(gitGraphWhen, entry.when) })) });
		}

		public override async run(accessor: ServicesAccessor, element: SCMHistoryItemViewModelTreeElement): Promise<void> {
			if (element?.type !== 'historyItemViewModel' || element.repository.provider.providerId !== 'git') { return; }
			try {
				await runGraphAction(accessor, kind, element);
			} catch (error) {
				accessor.get(INotificationService).error(localize('git.commandFailed', 'Git operation failed: {0}', gitErrorMessage(error)));
			}
		}
	});
}

const githubHistoryRemote = ContextKeyExpr.equals('scmHistoryItemRemoteAuthority', 'github.com');
for (const github of [true, false]) {
	MenusRegistry.appendMenuItem(MenuId.for('SCMHistoryItemHover'), {
		command: {
			id: 'git.graph.openRemote',
			title: github ? localize2('git.graph.openOnGitHub', 'Open on GitHub') : localize2('git.graph.openRemote', 'Open Commit in Browser'),
			icon: github ? Lxicon.github : Lxicon.linkExternal,
		},
		group: 'inline', order: 2,
		when: ContextKeyExpr.and(gitGraphWhen, ContextKeyExpr.has('scmHistoryItemHasRemote'), github ? githubHistoryRemote : ContextKeyExpr.notEquals('scmHistoryItemRemoteAuthority', 'github.com')),
	});
}

async function runGraphAction(accessor: ServicesAccessor, kind: GraphActionKind, element: SCMHistoryItemViewModelTreeElement): Promise<void> {
	const git = accessor.get(IGitService);
	const repositoryId = element.repository.provider.id;
	const commit = element.historyItemViewModel.historyItem;
	const references = element.references ?? commit.references ?? [];
	const input = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const promptName = (placeHolder: string, value?: string): Promise<string | undefined> => input.input({ placeHolder, value, validateInput: async name => name.trim() ? undefined : localize('git.valueRequired', 'Enter a value.') });
	const chooseReference = async (items: readonly ISCMHistoryItemRef[], placeHolder: string): Promise<ISCMHistoryItemRef | undefined> => {
		if (items.length === 1) { return items[0]; }
		return (await pickGitItem(input, items.map(reference => ({ label: reference.name, reference })), placeHolder))?.reference;
	};
	let command: GitCommand;
	switch (kind) {
		case 'copyHash':
			await accessor.get(IClipboardService).writeText(commit.id);
			return;
		case 'copyMessage':
			await accessor.get(IClipboardService).writeText(await git.commitMessage(commit.id, repositoryId));
			return;
		case 'openRemote': {
			const links = commit.remoteLinks ?? [];
			const selected = links.length === 1 ? links[0] : (await pickGitItem(input, links.map(link => ({ label: link.name, description: link.uri.toString(), link })), localize('git.graph.chooseRemote', 'Choose a hosting remote')))?.link;
			if (selected) { await accessor.get(IOpenerService).openExternal(selected.uri.toString()); }
			return;
		}
		case 'checkoutBranch': {
			const reference = await chooseReference(references.filter(reference => reference.category === 'localBranch' || reference.category === 'remoteBranch'), localize('git.graph.chooseBranch', 'Choose a branch at this commit'));
			if (!reference) { return; }
			if (reference.category === 'localBranch') {
				await git.switchBranch(reference.name, repositoryId);
				return;
			}
			const defaultName = reference.description ? reference.name.slice(reference.description.length + 1) : reference.name;
			const name = await promptName(localize('git.graph.trackingBranchName', 'Name for the new local tracking branch'), defaultName);
			if (name === undefined) { return; }
			command = { kind: 'checkoutRemoteBranch', name: name.trim(), reference: reference.name };
			break;
		}
		case 'checkoutDetached': {
			const confirmed = await accessor.get(IDialogService).confirm({ title: localize('git.graph.checkoutDetached', 'Checkout Commit (Detached)'), message: localize('git.graph.detachedConfirm', 'Check out commit {0}? HEAD will be detached. Create a branch before making new commits.', commit.displayId ?? commit.id), primaryButton: localize('git.graph.checkout', 'Checkout') });
			if (!confirmed.confirmed) { return; }
			command = { kind: 'checkoutDetached', objectId: commit.id };
			break;
		}
		case 'createBranch':
		case 'createTag': {
			const name = await promptName(kind === 'createBranch' ? localize('git.graph.branchName', 'Branch name (created at the selected commit without switching)') : localize('git.tagName', 'Tag name'));
			if (name === undefined) { return; }
			command = kind === 'createBranch' ? { kind: 'createBranchAt', name: name.trim(), objectId: commit.id } : { kind: 'createTag', name: name.trim(), reference: commit.id };
			break;
		}
		case 'deleteBranch': {
			const branches = await git.branches(repositoryId);
			const deletable = references.filter(reference => reference.category === 'localBranch' && branches.some(branch => branch.name === reference.name && !branch.current && !branch.checkedOutElsewhere));
			const reference = await chooseReference(deletable, localize('git.graph.chooseBranchToDelete', 'Choose a local branch to delete'));
			if (!reference) { return; }
			if (!(await accessor.get(IDialogService).confirm({ title: localize('git.graph.deleteBranch', 'Delete Branch…'), message: localize('git.graph.deleteBranchConfirm', 'Delete local branch {0}? Git will reject branches with unmerged commits or a worktree using them.', reference.name), primaryButton: localize('git.graph.delete', 'Delete') })).confirmed) { return; }
			await git.deleteBranch(reference.name, repositoryId);
			return;
		}
		case 'cherryPick': {
			if (commit.parentIds.length > 1) {
				const selected = await pickGitItem(input, commit.parentIds.map((parent, index) => ({ label: localize('git.graph.mainlineParent', 'Parent {0} ({1})', index + 1, parent.slice(0, 7)), mainline: index + 1 })), localize('git.graph.chooseMainline', 'Choose the parent to use as the base of this merge commit'));
				if (!selected) { return; }
				command = { kind: 'cherryPick', reference: commit.id, mainline: selected.mainline };
			} else {
				command = { kind: 'cherryPick', reference: commit.id };
			}
			break;
		}
		case 'compare':
		case 'compareMergeBase':
		case 'compareRemote': {
			let baseReference: string | undefined;
			let baseLabel: string | undefined;
			if (kind === 'compareRemote') {
				const reference = await chooseReference(references.filter(reference => reference.upstream !== undefined), localize('git.graph.chooseUpstream', 'Choose the branch whose remote you want to compare'));
				baseLabel = reference?.upstream;
				baseReference = baseLabel === undefined ? undefined : `refs/remotes/${baseLabel}`;
			} else {
				const [branches, catalog] = await Promise.all([git.branches(repositoryId), git.catalog(repositoryId)]);
				const options: Array<IQuickPickItem & { reference?: string }> = [
					...branches.map(branch => ({ label: branch.name, description: branch.objectId.slice(0, 7), reference: `refs/heads/${branch.name}` })),
					...catalog.tags.map(tag => ({ label: tag.name, description: tag.objectId.slice(0, 7), reference: `refs/tags/${tag.name}` })),
					{ label: localize('git.graph.enterReference', 'Enter Commit or Reference…') },
				];
				const selected = await pickGitItem(input, options, localize('git.graph.compareBase', 'Choose the left side to compare with selected commit {0} on the right', commit.displayId ?? commit.id));
				if (!selected) { return; }
				baseLabel = selected.reference ? selected.label : undefined;
				baseReference = selected.reference ?? (await promptName(localize('git.graph.reference', 'Commit hash, branch, tag or remote reference (left side)')))?.trim();
			}
			if (!baseReference) { return; }
			const mode = kind === 'compareMergeBase' ? 'mergeBase' : 'direct';
			const comparison = await git.compareChanges(commit.id, baseReference, mode, repositoryId);
			const label = mode === 'mergeBase'
				? localize('git.graph.mergeBaseTitle', 'Merge base with {0} ({1}) → {2}', baseLabel ?? baseReference, comparison.baseObjectId.slice(0, 7), commit.displayId ?? commit.id)
				: localize('git.graph.compareTitle', '{0} ({1}) → {2}', baseLabel ?? baseReference, comparison.baseObjectId.slice(0, 7), commit.displayId ?? commit.id);
			await accessor.get(ICommandService).executeCommand('workbench.scm.action.graph.viewChanges', element, { baseId: comparison.baseObjectId, label } satisfies ISCMHistoryItemComparison);
			return;
		}
	}
	const result = await git.executeCommand(command, repositoryId);
	if (result.outcome === 'conflicted') {
		notifications.warning(localize('git.integrationConflicts', 'Git stopped on conflicts. Resolve the files in Source Control, then run Git: Continue. Use Git: Abort to cancel an integration.'));
	} else {
		notifications.info(localize('git.commandCompleted', 'Git operation completed.'));
	}
}
