import { commands, window, type ExtensionContext } from 'vscode';
import { editors } from 'ash';
import { AppServerRemoteError, CancellationError, localize, URI, extUriBiasedIgnorePathCase } from './support.js';
import { runDiffChange } from './diffActions.js';
import { gitErrorMessage } from './gitError.js';
import type { GitService } from './gitService.js';
import type { GitSCMProvider } from './gitSCMProvider.js';
import type { GitBackendMonitor } from './monitor.js';
import type { GitBranch, GitCommand, GitIndexSelection, GitIndexDiff, GitChangeFileComparison } from './types.js';
import { input, dialogClient, editorClient, commandClient } from './editors.js';
import { createGitMultiDiffEditorInput } from './multiDiff.js';
import type { ISCMHistoryItemComparison, ISCMHistoryItem, ISCMHistoryItemRef, IResourceEditorInput } from '../../../sdk/browser/index.js';

interface PickItem { readonly label: string; readonly description?: string; readonly detail?: string; }
interface HistoryTarget { type: 'historyItemViewModel'; repository: { provider: { id: string; providerId: string; }; }; historyItemViewModel: { historyItem: ISCMHistoryItem; }; references?: readonly ISCMHistoryItemRef[]; }
interface GitCommandContext {
	git: GitService;
	providers: ReadonlyMap<string, GitSCMProvider>;
	monitor: GitBackendMonitor;
	input: { input: typeof input; };
	dialogs: typeof dialogClient;
	commands: typeof commandClient;
	editor: typeof editorClient;
	clipboard: { writeText(text: string): Promise<void>; };
	opener: { open(uri: URI, options: unknown): Promise<void>; };
	notifications: { info(message: string): void; warning(message: string): void; error(message: string): void; };
}
export function registerGitCommands(context: ExtensionContext, git: GitService, providers: ReadonlyMap<string, GitSCMProvider>, monitor: GitBackendMonitor, showOutput: () => void): void {
	const ctx: GitCommandContext = {
		git, providers, monitor, input: { input }, dialogs: dialogClient, commands: commandClient, editor: editorClient,
		clipboard: { writeText: text => editors.request({ method: 'clipboard', text }) },
		opener: { open: uri => editors.request({ method: 'openExternal', uri: uri.toString() }) },
		notifications: { info: message => { void window.showInformationMessage(message); }, warning: message => { void window.showWarningMessage(message); }, error: message => { void window.showErrorMessage(message); } },
	};
	const register = (id: string, callback: (...args: readonly unknown[]) => unknown): void => {
		context.subscriptions.push(commands.registerCommand(id, async (...args: readonly unknown[]) => {
			try { return await callback(...args); } catch (error) {
				// Opening another workspace retires this callback; its cancellation is not a Git failure.
				if (error instanceof CancellationError || error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled')) throw error;
				ctx.notifications.error(localize('git.commandFailed', 'Git operation failed: {0}', gitErrorMessage(error)));
				throw error;
			}
		}));
	};
	const repositoryId = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'repositoryId' in value && typeof value.repositoryId === 'string' ? value.repositoryId : undefined;
	const provider = (value?: unknown): GitSCMProvider | undefined => providers.get(repositoryId(value) ?? git.activeRepository?.id ?? '');
	const providerCommands = [
		['git.commit', {}], ['git.commitStaged', { scope: 'staged' }], ['git.commitSigned', { signoff: 'add' }], ['git.commitStagedSigned', { scope: 'staged', signoff: 'add' }],
		['git.commitAmend', { mode: 'amend' }], ['git.commitStagedAmend', { scope: 'staged', mode: 'amend' }],
	] as const;
	for (const [id, options] of providerCommands) { register(id, value => provider(value)?.commit(options)); }
	for (const [id, options] of [['git.commitAll', {}], ['git.commitAllSigned', { signoff: 'add' }], ['git.commitAllAmend', { mode: 'amend' }]] as const) {
		register(id, value => provider(value)?.commit(options, async () => (await pickGitItem(ctx.input, [{ label: localize('git.commitTracked', 'Tracked changes only'), scope: 'tracked' as const }, { label: localize('git.commitIncludingUntracked', 'Tracked and untracked changes'), scope: 'includeUntracked' as const }], localize('git.commitScope', 'Choose changes to commit')))?.scope));
	}
	for (const [id, method] of [['git.undoCommit', 'undoCommit'], ['git.refresh', 'refresh'], ['git.stageAll', 'stageAll'], ['git.unstageAll', 'unstageAll'], ['git.cleanAll', 'discardAll']] as const) { register(id, value => provider(value)?.[method]()); }
	for (const mode of ['choose', 'all'] as const) {
		register(mode === 'all' ? 'git.fetchAll' : 'git.fetch', async value => {
			const id = (await git.getRepository(repositoryId(value))).id;
			const catalog = await git.catalog(id);
			const remotes = [...catalog.remotes];
			const upstream = catalog.upstreamRemote ? remotes.indexOf(catalog.upstreamRemote) : -1;
			if (upstream > 0) { remotes.unshift(...remotes.splice(upstream, 1)); }
			if (!remotes.length) { ctx.notifications.warning(localize('git.fetchAllNoRemotes', 'This repository has no remotes configured to fetch from.')); return; }
			let target: 'all' | 'default' | { remote: string; } = mode === 'all' ? 'all' : 'default';
			if (mode === 'choose' && remotes.length > 1) { const selected = await pickGitItem(ctx.input, [...remotes.map(remote => ({ label: remote, remote })), { label: localize('git.fetchAllRemotesItem', 'Fetch all remotes'), remote: undefined }], localize('git.fetchChooseRemote', 'Select a remote to fetch')); if (!selected) { return; } target = selected.remote ? { remote: selected.remote } : 'all'; }
			await provider(id)?.runTitleOperation(() => git.fetch(id, target));
		});
	}
	const publish = async (value?: unknown): Promise<void> => {
		const id = (await git.getRepository(repositoryId(value))).id;
		const status = await git.status(id);
		if (status.head.type !== 'branch') { ctx.notifications.info(localize('git.publishNeedsCommit', 'Create a commit on a branch before publishing it.')); return; }
		const head = status.head;
		const { remotes } = await git.catalog(id);
		if (!remotes.length) { ctx.notifications.info(localize('git.publishNeedsRemote', 'Add a Git remote before publishing this branch.')); return; }
		const remote = remotes.length === 1 ? remotes[0] : (await pickGitItem(ctx.input, remotes.map(remote => ({ label: remote, remote })), localize('git.publishChooseRemote', 'Choose the remote to publish this branch to')))?.remote;
		if (!remote) { return; }
		await provider(id)?.runTitleOperation(async () => {
			const result = await git.executeCommand({ kind: 'publishBranch', remote, name: head.name, branch: head.name, expectedHead: head.objectId }, id);
			return result.status;
		});
	};
	register('git.publish', publish);
	for (const [id, mode] of [['git.sync', 'sync'], ['git.syncRebase', 'rebase']] as const) {
		register(id, async value => {
			const current = provider(value);
			if (!current || current.isBusy) return;
			const status = await git.status(current.id);
			if (status.head.type === 'branch' && !status.head.upstream) await publish(current.id);
			else await current.sync(mode);
		});
	}
	register('git.pullRebase', value => provider(value)?.runTitleOperation(() => git.pull(repositoryId(value), 'rebase')));
	for (const method of ['pull', 'push'] as const) { register(`git.${method}`, value => provider(value)?.runTitleOperation(() => git[method](repositoryId(value)))); }
	for (const definition of repositoryCommands) {
		register(definition.id, async value => {
			if (definition.kind === 'createTag' && value && typeof value === 'object' && 'type' in value && value.type === 'historyItemViewModel') { return runGraphAction(ctx, 'createTag', reviveHistoryTarget(value)); }
			const id = (await git.getRepository(repositoryId(value))).id;
			const command = await prepareGitCommand(ctx, definition.kind, id);
			if (!command) { return; }
			const result = await git.executeCommand(command, id);
			if (result.outcome === 'conflicted') { ctx.notifications.warning(localize('git.integrationConflicts', 'Git stopped on conflicts. Resolve the files in Source Control, then run Git: Continue. Use Git: Abort to cancel an integration.')); }
		});
	}
	registerBranchCommands(register, ctx, repositoryId);
	register('git.init', async () => { const folders = monitor.workspace.getWorkspace().folders; const selected = await pickGitItem(ctx.input, folders.map(folder => ({ label: folder.name, folder })), localize('git.initFolder', 'Choose a workspace folder to initialize')); if (!selected) { return; } const branch = await input({ value: 'main', placeHolder: localize('git.initBranch', 'Initial branch name') }); if (branch !== undefined) { await git.initializeRepository(branch.trim(), selected.folder.id); ctx.notifications.info(localize('git.initialized', 'Git repository initialized.')); } });
	register('git.clone', async () => { if (!git.canCloneRepository) { throw new Error(localize('git.cloneUnavailable', 'Cloning is unavailable in this host.')); } const url = await input({ title: localize('git.cloneUrlTitle', 'Clone Repository'), placeHolder: localize('git.cloneUrlPlaceholder', 'Enter a repository URL'), validateInput: async value => value.trim() ? undefined : localize('git.cloneUrlRequired', 'Enter a repository URL.') }); if (url === undefined) { return; } const parentPath = await editors.request<string | null>({ method: 'pickFolder' }); if (!parentPath) { return; } const path = await git.cloneRepository(url.trim(), parentPath); if ((await dialogClient.confirm({ title: localize('git.cloneCompleteTitle', 'Repository cloned'), message: localize('git.cloneCompleteMessage', 'Open the cloned repository at {0}?', path), primaryButton: localize('git.openClonedRepository', 'Open Repository') })).confirmed) { await editors.request({ method: 'openWorkspace', path }); } });
	register('git.createWorktree', async value => { const id = (await git.getRepository(repositoryId(value))).id; const name = await input({ title: localize('git.createWorktreeCommandTitle', 'Git: Create Worktree'), placeHolder: localize('git.newWorktreeName', 'Name of the new detached worktree at HEAD'), validateInput: async value => /^[a-zA-Z0-9_-]{1,64}$/.test(value.trim()) ? undefined : localize('git.worktreeNameInvalid', 'Use 1–64 letters, numbers, hyphens or underscores.') }); if (!name) { return; } const path = await git.createWorktree(name.trim(), id); if ((await dialogClient.confirm({ title: localize('git.openWorktreeCommandTitle', 'Git: Open Worktree'), primaryButton: localize('git.openWorktreeButton', 'Open Worktree'), message: localize('git.openWorktreeConfirm', 'Open the worktree at {0}?', path) })).confirmed) { await editors.request({ method: 'openWorkspace', path }); } });
	for (const method of ['open', 'delete'] as const) { register(`git.${method}Worktree`, async value => { const id = (await git.getRepository(repositoryId(value))).id; const selected = await pickGitItem(ctx.input, (await git.worktrees(id)).filter(worktree => !worktree.current && worktree.state === 'ready').map(worktree => ({ label: worktree.checkoutRoot, worktree })), localize(method === 'open' ? 'git.selectWorktreeToOpen' : 'git.selectWorktreeToDelete', method === 'open' ? 'Select a Git worktree to open' : 'Select a Git worktree to delete')); if (!selected) { return; } if (method === 'open') { await editors.request({ method: 'openWorkspace', path: await git.resolveWorktree(selected.worktree.checkoutRoot, id) }); } else if ((await dialogClient.confirm({ title: localize('git.deleteWorktreeCommandTitle', 'Git: Delete Worktree'), primaryButton: localize('git.deleteWorktreeButton', 'Delete Worktree'), detail: localize('git.deleteWorktreeDetail', 'Git only removes clean linked worktrees that are not held by a session or currently open in this workspace.'), message: localize('git.deleteWorktreeConfirm', 'Delete the worktree at {0}?', selected.label) })).confirmed) { try { await git.deleteWorktree(selected.worktree.checkoutRoot, id); } catch (error) { const reason = error instanceof AppServerRemoteError && error.errorName === 'GitOperationFailed' ? localize('git.deleteWorktreeRejected', 'The worktree could not be deleted. Check local changes, locks and session ownership.') : gitErrorMessage(error); ctx.notifications.error(localize('git.deleteWorktreeFailed', 'Could not delete worktree: {0}', reason)); } } }); }
	for (const [id, comparison, mode] of [['git.stageHunk', 'unstaged', 'hunk'], ['git.unstageHunk', 'staged', 'hunk'], ['git.stageSelectedRanges', 'unstaged', 'lines'], ['git.unstageSelectedRanges', 'staged', 'lines']] as const) { register(id, () => runIndexSelection(ctx, comparison, mode)); }
	for (const [id, comparison, operation] of [
		['git.diff.stageHunk', 'unstaged', 'index'], ['git.diff.stageSelection', 'unstaged', 'index'],
		['git.diff.unstageHunk', 'staged', 'index'], ['git.diff.unstageSelection', 'staged', 'index'],
		['git.diff.revertHunk', 'unstaged', 'revert'], ['git.diff.revertSelection', 'unstaged', 'revert'],
	] as const) { register(id, value => runDiffChange({ git, editors, dialogs: dialogClient }, value, comparison, operation)); }
	for (const [id, kind] of [
		['git.graph.openRemote', 'openRemote'], ['git.graph.checkout', 'checkout'], ['git.graph.checkoutDetached', 'checkoutDetached'],
		['git.graph.deleteBranch', 'deleteBranch'], ['git.graph.deleteTag', 'deleteTag'], ['git.graph.cherryPick', 'cherryPick'],
		['git.graph.compareWithRemote', 'compareRemote'], ['git.graph.compareWithMergeBase', 'compareMergeBase'], ['git.graph.compareRef', 'compare'],
		['git.copyCommitId', 'copyHash'], ['git.copyCommitMessage', 'copyMessage'],
	] as const) { register(id, value => runGraphAction(ctx, kind, reviveHistoryTarget(value))); }
	for (const scope of ['staged', 'unstaged', 'uncommitted'] as const) { register(`git.open${scope[0].toUpperCase()}${scope.slice(1)}Changes`, async () => editorClient.openEditor(await createGitMultiDiffEditorInput(git, scope), { pinned: true })); }
	register('git.openChanges', async value => { const options = value as { status: Parameters<typeof createGitMultiDiffEditorInput>[2]; comparison: 'staged' | 'unstaged'; title: string; changes: Parameters<typeof createGitMultiDiffEditorInput>[4]; }; const current = await git.status(options.status!.repositoryId); if (current.streamInstanceId !== options.status!.streamInstanceId || current.revision !== options.status!.revision) { return 'stale'; } const input = await createGitMultiDiffEditorInput(git, options.comparison, options.status, options.title, options.changes); if (!input.items.length) { return 'empty'; } await editorClient.openEditor(input, { pinned: true }); return 'opened'; });
	register('git.getRepositoryContexts', async () => Promise.all((await git.listRepositories()).map(async repository => {
		const [status, graph] = await Promise.all([git.status(repository.id), git.graph({ limit: 1 }, repository.id)]);
		return {
			id: repository.id, label: repository.label, path: repository.path, root: repository.root.toString(),
			head: status.head, remotes: graph.remotes, uncommittedChanges: status.changes.length,
		};
	})));
	register('git.executeRepositoryCommand', async (id, command) => { if (typeof id !== 'string' || !command || typeof command !== 'object') throw new TypeError('Invalid Git command'); return git.executeCommand(command as GitCommand, id); });
	register('git.openChangesSource', async (id, scope) => { if (typeof id !== 'string' || scope !== 'staged' && scope !== 'unstaged' && scope !== 'uncommitted') throw new TypeError('Invalid Git source'); await editorClient.openEditor(await createGitMultiDiffEditorInput(git, scope, await git.status(id)), { pinned: true }); });
	for (const [command, action] of [['git.stageFile', 'stage'], ['git.unstageFile', 'unstage'], ['git.discardFile', 'discard']] as const) register(command, async (id, path) => { if (typeof id !== 'string' || typeof path !== 'string') throw new TypeError('Invalid Git path'); await provider(id)?.mutatePaths(action, [path]); });
	for (const push of [false, true]) register(push ? 'git.commitAndPushFromChanges' : 'git.commitFromChanges', async id => {
		const target = provider(id); if (!target) return;
		const message = await input({ title: localize('git.commitMessageTitle', 'Commit message'), value: target.input.value, validateInput: async value => value.trim() ? undefined : localize('git.commitMessageRequired', 'Enter a commit message.') });
		if (message === undefined) return;
		target.input.value = message; const objectId = await target.commit({}, async () => (await pickGitItem(ctx.input, [{ label: localize('git.commitStaged', 'Staged changes'), scope: 'staged' as const }, { label: localize('git.commitTracked', 'Tracked changes only'), scope: 'tracked' as const }, { label: localize('git.commitIncludingUntracked', 'Tracked and untracked changes'), scope: 'includeUntracked' as const }], localize('git.commitScope', 'Choose changes to commit')))?.scope);
		if (push && objectId) await target.runTitleOperation(() => git.push(target.id));
	});
	register('git.readSettings', () => git.readSettings());
	register('git.updateRebaseWhenSync', value => {
		if (typeof value !== 'boolean') throw new TypeError(localize('git.rebaseWhenSync.invalid', 'Rebase When Sync must be a boolean.'));
		return git.setRebaseWhenSync(value);
	});
	register('git.updateAutoFetch', value => git.setAutoFetch(value as false | true | 'all'));
	register('git.updateAutoFetchPeriod', value => git.setAutoFetchPeriod(Number(value)));
	register('ash.git.pull', value => commands.executeCommand('git.pull', value));
	register('ash.git.push', value => commands.executeCommand('git.push', value));
	register('git.showOutput', showOutput);
	register('git.openFile', async context => { const state = await editors.request<{ input: { modified?: { resource: string; }; }; selection: NonNullable<Parameters<typeof editorClient.openEditor>[1]>['selection'] | null; }>({ method: 'activeEditor', context }); const resource = state.input?.modified?.resource; if (!resource) { return; } const target = new URLSearchParams(URI.parse(resource).query).get('resource'); if (target) { await editorClient.openEditor({ resource: URI.parse(target) }, { pinned: false, revealIfOpened: true, ...(state.selection ? { selection: state.selection } : {}) }); } });
}
function registerBranchCommands(register: (id: string, callback: (...args: readonly unknown[]) => unknown) => void, ctx: GitCommandContext, repositoryId: (value: unknown) => string | undefined): void {
	register('git.switchBranch', async value => {
		try {
			const id = (await ctx.git.getRepository(repositoryId(value))).id;
			const branches = await ctx.git.branches(id);
			if (!branches.length) { ctx.notifications.info(localize('git.noBranches', 'This repository has no branches to switch to.')); return; }
			const selected = await pickBranch(branches, localize('git.selectBranch', 'Select a Git branch'));
			if (!selected || selected.current) { return; }
			if (selected.checkedOutElsewhere) { ctx.notifications.warning(localize('git.branchCheckedOutElsewhere', 'Branch {0} is checked out in another worktree.', selected.name)); return; }
			await ctx.git.switchBranch(selected.name, id);
		} catch (error) {
			const reason = error instanceof AppServerRemoteError && error.errorName === 'GitOperationFailed' ? localize('git.switchBranchRejected', 'Git rejected the switch. Check local changes and worktrees.') : gitErrorMessage(error);
			ctx.notifications.error(localize('git.switchBranchFailed', 'Could not switch branch: {0}', reason));
		}
	});
	register('git.branch', async value => {
		if (value && typeof value === 'object' && 'type' in value && value.type === 'historyItemViewModel') { return runGraphAction(ctx, 'createBranch', reviveHistoryTarget(value)); }
		try {
			const id = (await ctx.git.getRepository(repositoryId(value))).id;
			const branches = await ctx.git.branches(id);
			const name = await input({
				title: localize('git.createBranchCommandTitle', 'Git: Create Branch'),
				placeHolder: localize('git.newBranchName', 'Name of the new branch at HEAD'),
				validateInput: async value => {
					if (!value.trim()) { return localize('git.branchNameRequired', 'Enter a branch name.'); }
					if (branches.some(branch => branch.name === value.trim())) { return localize('git.branchAlreadyExists', 'This branch already exists.'); }
					return undefined;
				},
			});
			if (name === undefined) { return; }
			await ctx.git.createBranch(name.trim(), id);
			ctx.notifications.info(localize('git.branchCreated', 'Created branch {0}. The current branch is unchanged.', name.trim()));
		} catch (error) { ctx.notifications.error(localize('git.createBranchFailed', 'Could not create branch: {0}', gitErrorMessage(error))); }
	});
	register('git.deleteBranch', async value => {
		try {
			const id = (await ctx.git.getRepository(repositoryId(value))).id;
			const branches = (await ctx.git.branches(id)).filter(branch => !branch.current);
			if (!branches.length) { ctx.notifications.info(localize('git.noBranchesToDelete', 'There are no other local branches to delete.')); return; }
			const selected = await pickBranch(branches, localize('git.selectBranchToDelete', 'Select a Git branch to delete'));
			if (!selected) { return; }
			if (selected.checkedOutElsewhere) { ctx.notifications.warning(localize('git.branchCheckedOutElsewhere', 'Branch {0} is checked out in another worktree.', selected.name)); return; }
			const confirmation = await dialogClient.confirm({
				title: localize('git.deleteBranchCommandTitle', 'Git: Delete Branch'),
				message: localize('git.deleteBranchConfirm', 'Delete local branch {0}?', selected.name),
				detail: localize('git.deleteBranchDetail', 'Git only deletes merged branches that are not checked out in any worktree.'),
				primaryButton: localize('git.deleteBranchButton', 'Delete Branch'),
			});
			if (!confirmation.confirmed) { return; }
			await ctx.git.deleteBranch(selected.name, id);
			ctx.notifications.info(localize('git.branchDeleted', 'Deleted branch {0}.', selected.name));
		} catch (error) {
			const reason = error instanceof AppServerRemoteError && error.errorName === 'GitOperationFailed' ? localize('git.deleteBranchRejected', 'Git rejected the deletion. Check unmerged commits and worktrees.') : gitErrorMessage(error);
			ctx.notifications.error(localize('git.deleteBranchFailed', 'Could not delete branch: {0}', reason));
		}
	});
}

async function pickBranch(branches: readonly GitBranch[], placeHolder: string): Promise<GitBranch | undefined> {
	const selected = await window.showQuickPick(branches.map(branch => ({
		label: branch.name,
		description: branch.current ? localize('git.currentBranch', 'Current') : branch.upstream,
		detail: branch.checkedOutElsewhere ? localize('git.branchWorktreeOccupancy', 'Checked out in another worktree') : undefined,
		branch,
	})), { placeHolder });
	return selected?.branch;
}

async function pickGitItem<T extends PickItem>(_input: GitCommandContext['input'], items: readonly (T | { type: 'separator'; })[], placeHolder: string): Promise<T | undefined> {
	const values = items.filter((item): item is T => !('type' in item));
	return await window.showQuickPick([...values], { placeHolder });
}
function reviveHistoryTarget(value: unknown): HistoryTarget {
	if (!value || typeof value !== 'object' || !('historyItemViewModel' in value)) { throw new TypeError('Expected SCM history command context'); }
	const target = value as HistoryTarget;
	const item = target.historyItemViewModel.historyItem;
	return { ...target, historyItemViewModel: { historyItem: { ...item, remoteLinks: item.remoteLinks?.map(link => ({ ...link, uri: typeof link.uri === 'string' ? URI.parse(link.uri) : link.uri })) } } };
}
type RepositoryCommandKind = Exclude<GitCommand['kind'], 'createBranchAt' | 'checkoutDetached' | 'checkoutRemoteBranch' | 'fetchAndCheckout' | 'pushBranch' | 'publishBranch' | 'amend' | 'undoCommit'>;

const repositoryCommands: readonly { readonly kind: RepositoryCommandKind; readonly id: string; readonly key: string; readonly title: string; }[] = [
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
];

async function prepareGitCommand(accessor: GitCommandContext, kind: RepositoryCommandKind, repositoryId: string): Promise<GitCommand | undefined> {
	const git = accessor.git;
	const input = accessor.input;
	const prompt = (placeHolder: string, value?: string) => input.input({
		placeHolder, value,
		validateInput: async text => text.trim() ? undefined : localize('git.valueRequired', 'Enter a value.'),
	});
	const confirm = async (message: string) => (await accessor.dialogs.confirm({
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
				accessor.notifications.info(localize('git.noIntegration', 'No merge, rebase or cherry-pick is in progress.'));
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
	}
}


type GraphActionKind = 'openRemote' | 'checkout' | 'checkoutDetached' | 'createBranch' | 'deleteBranch' | 'createTag' | 'deleteTag' | 'cherryPick' | 'compareRemote' | 'compareMergeBase' | 'compare' | 'copyHash' | 'copyMessage';
async function runGraphAction(accessor: GitCommandContext, kind: GraphActionKind, element: HistoryTarget): Promise<void> {
	const git = accessor.git;
	const repositoryId = element.repository.provider.id;
	const commit = element.historyItemViewModel.historyItem;
	const references = element.references ?? commit.references ?? [];
	const input = accessor.input;
	const notifications = accessor.notifications;
	const promptName = (placeHolder: string, value?: string): Promise<string | undefined> => input.input({ placeHolder, value, validateInput: async name => name.trim() ? undefined : localize('git.valueRequired', 'Enter a value.') });
	const chooseReference = async (items: readonly ISCMHistoryItemRef[], placeHolder: string): Promise<ISCMHistoryItemRef | undefined> => {
		if (items.length === 1) { return items[0]; }
		return (await pickGitItem(input, items.map(reference => ({ label: reference.name, reference })), placeHolder))?.reference;
	};
	let command: GitCommand;
	switch (kind) {
		case 'copyHash':
			await accessor.clipboard.writeText(commit.id);
			return;
		case 'copyMessage':
			await accessor.clipboard.writeText(await git.commitMessage(commit.id, repositoryId));
			return;
		case 'openRemote': {
			const links = commit.remoteLinks ?? [];
			const selected = links.length === 1 ? links[0] : (await pickGitItem(input, links.map(link => ({ label: link.name, description: link.uri.toString(), link })), localize('git.graph.chooseRemote', 'Choose a hosting remote')))?.link;
			if (selected) { await accessor.opener.open(selected.uri, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }); }
			return;
		}
		case 'checkout': {
			const reference = await chooseReference(references, localize('git.graph.chooseReference', 'Choose a reference at this commit'));
			if (!reference) { return; }
			if (reference.category === 'localBranch') {
				await git.switchBranch(reference.name, repositoryId);
				return;
			}
			if (reference.category === 'tag') {
				command = { kind: 'checkoutDetached', objectId: commit.id };
				break;
			}
			const { remotes } = await git.catalog(repositoryId);
			const remote = [...remotes].sort((left, right) => right.length - left.length).find(remote => reference.name.startsWith(`${remote}/`));
			const defaultName = remote ? reference.name.slice(remote.length + 1) : reference.name;
			const name = await promptName(localize('git.graph.trackingBranchName', 'Name for the new local tracking branch'), defaultName);
			if (name === undefined) { return; }
			command = { kind: 'checkoutRemoteBranch', name: name.trim(), reference: reference.name };
			break;
		}
		case 'checkoutDetached': {
			const confirmed = await accessor.dialogs.confirm({ title: localize('git.graph.checkoutDetached', 'Checkout Commit (Detached)'), message: localize('git.graph.detachedConfirm', 'Check out commit {0}? HEAD will be detached. Create a branch before making new commits.', commit.displayId ?? commit.id), primaryButton: localize('git.graph.checkout', 'Checkout') });
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
			const deletable = references.filter(reference => reference.category === 'remoteBranch' || reference.category === 'localBranch' && branches.some(branch => branch.name === reference.name && !branch.current && !branch.checkedOutElsewhere));
			const reference = await chooseReference(deletable, localize('git.graph.chooseBranchToDelete', 'Choose a local branch to delete'));
			if (!reference) { return; }
			if (reference.category === 'remoteBranch') {
				const { remotes } = await git.catalog(repositoryId);
				const remote = [...remotes].sort((left, right) => right.length - left.length).find(name => reference.name.startsWith(`${name}/`));
				if (!remote) { return; }
				const name = reference.name.slice(remote.length + 1);
				const confirmation = await accessor.dialogs.confirm({
					title: localize('git.deleteRemoteBranchTitle', 'Git: Delete Remote Branch'),
					message: localize('git.deleteRemoteBranchConfirm', 'Delete branch {0} from remote {1}?', name, remote),
					primaryButton: localize('git.graph.delete', 'Delete'),
				});
				if (confirmation.confirmed) { await git.executeCommand({ kind: 'deleteRemoteBranch', remote, name }, repositoryId); }
				return;
			}
			if (!(await accessor.dialogs.confirm({ title: localize('git.graph.deleteBranch', 'Delete Branch…'), message: localize('git.graph.deleteBranchConfirm', 'Delete local branch {0}? Git will reject branches with unmerged commits or a worktree using them.', reference.name), primaryButton: localize('git.graph.delete', 'Delete') })).confirmed) { return; }
			await git.deleteBranch(reference.name, repositoryId);
			return;
		}
		case 'deleteTag': {
			const reference = await chooseReference(references.filter(reference => reference.category === 'tag'), localize('git.graph.chooseTagToDelete', 'Choose a tag to delete'));
			if (!reference) { return; }
			const confirmation = await accessor.dialogs.confirm({
				title: localize('git.graph.deleteTag', 'Delete Tag…'),
				message: localize('git.deleteTagConfirm', 'Delete tag {0}?', reference.name),
				primaryButton: localize('git.graph.delete', 'Delete'),
			});
			if (!confirmation.confirmed) { return; }
			command = { kind: 'deleteTag', name: reference.name };
			break;
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
			if (kind === 'compareRemote' || kind === 'compareMergeBase') {
				const history = accessor.providers.get(repositoryId)?.historyProvider;
				const reference = kind === 'compareRemote' ? history?.historyItemRemoteRef.get() : history?.historyItemBaseRef.get();
				baseReference = reference?.revision;
				baseLabel = reference?.name;
			} else {
				const snapshot = await git.historyRefs(repositoryId);
				const options: Array<PickItem & { reference?: string; }> = [
					...snapshot.references.map(reference => {
						const namespace = { localBranch: 'refs/heads', remoteBranch: 'refs/remotes', tag: 'refs/tags' }[reference.kind];
						return { label: reference.name, description: reference.objectId.slice(0, 7), reference: `${namespace}/${reference.name}` };
					}),
					{ label: localize('git.graph.enterReference', 'Enter Commit or Reference…') },
				];
				const selected = await pickGitItem(input, options, localize('git.graph.compareBase', 'Choose the left side to compare with selected commit {0} on the right', commit.displayId ?? commit.id));
				if (!selected) { return; }
				baseLabel = selected.reference ? selected.label : undefined;
				baseReference = selected.reference ?? (await promptName(localize('git.graph.reference', 'Commit hash, branch, tag or remote reference (left side)')))?.trim();
			}
			if (!baseReference) { return; }
			const comparison = await git.compareChanges(commit.id, baseReference, 'direct', repositoryId);
			const label = localize('git.graph.compareTitle', '{0} ({1}) → {2}', baseLabel ?? baseReference, comparison.baseObjectId.slice(0, 7), commit.displayId ?? commit.id);
			await accessor.commands.executeCommand('workbench.scm.action.graph.viewChanges', element, { baseId: comparison.baseObjectId, label } satisfies ISCMHistoryItemComparison);
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

async function runIndexSelection(ctx: GitCommandContext, comparison: GitChangeFileComparison, mode: 'hunk' | 'lines'): Promise<void> {
	const git = ctx.git;
	const repository = await git.getRepository();
	const status = await git.status(repository.id);
	let path: string;
	let selection: GitIndexSelection;
	let reviewed: GitIndexDiff;
	if (mode === 'lines') {
		const state = await editors.request<{ input: { resource: string; modified: { resource: string; } | null; } | null; selection: { startLineNumber: number; endLineNumber?: number; endColumn?: number; } | null; }>({ method: 'activeEditor' });
		if (!state.input || !state.selection) { throw new Error(localize('git.selectText', 'Select lines in a file or Git comparison editor.')); }
		const resource = URI.parse(state.input.modified?.resource ?? state.input.resource);
		if (state.input.modified) {
			const query = new URLSearchParams(resource.query);
			if (resource.scheme !== 'git-change' || !resource.path.startsWith(`/${comparison}/`) || query.get('stream') !== status.streamInstanceId || query.get('revision') !== String(status.revision)) { throw new Error(localize('git.reopenComparison', 'Open the current comparison from Source Control before selecting lines.')); }
			path = resource.path.slice(comparison.length + 2).split('/').map(decodeURIComponent).join('/');
		} else {
			if (comparison !== 'unstaged' || !extUriBiasedIgnorePathCase.isEqualOrParent(resource, repository.root)) { throw new Error(localize('git.reopenComparison', 'Open the current comparison from Source Control before selecting lines.')); }
			path = resource.path.slice(repository.root.path.replace(/\/$/, '').length + 1);
			const dirty = await editors.request<readonly { isDirty: boolean; }[]>({ method: 'dirty', uri: resource.toString() });
			if (dirty.some(copy => copy.isDirty)) { if (!(await dialogClient.confirm({ message: localize('git.saveBeforeStage', 'Save this file before staging its selected lines?') })).confirmed) { return; } await editors.request({ method: 'save', uri: resource.toString() }); }
		}
		reviewed = await git.indexDiff(path, comparison, repository.id);
		selection = { kind: 'lines', start: state.selection.startLineNumber, end: state.selection.endColumn === 1 && (state.selection.endLineNumber ?? 0) > state.selection.startLineNumber ? state.selection.endLineNumber! - 1 : state.selection.endLineNumber ?? state.selection.startLineNumber };
	} else {
		const selected = await pickGitItem(ctx.input, status.changes.filter(change => !change.conflicted && (comparison === 'staged' ? change.indexStatus : change.worktreeStatus) !== 'unmodified').map(change => ({ label: change.path })), localize('git.chooseIndexFile', 'Choose a changed file'));
		if (!selected) { return; }
		path = selected.label;
		reviewed = await git.indexDiff(path, comparison, repository.id);
		const hunk = await pickGitItem(ctx.input, reviewed.hunks.map(hunk => ({ label: localize('git.hunkLines', 'Lines {0}–{1}', hunk.newStart, Math.max(hunk.newStart, hunk.newStart + hunk.newCount - 1)), detail: hunk.preview, hunk })), localize('git.chooseHunk', 'Choose a change block'));
		if (!hunk) { return; }
		selection = { kind: 'hunk', index: hunk.hunk.index };
	}
	await git.editIndex(path, comparison, reviewed, selection, repository.id);
	ctx.notifications.info(localize('git.indexEdited', 'Selected changes updated in the index.'));
}
