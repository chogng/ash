import type { IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { createDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IViewsService } from '../../../services/views/browser/viewsService.js';
import type { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { OpenScmMultiDiffEditorCommandId, type OpenScmMultiDiffEditorOptions, type OpenScmMultiDiffEditorResult } from '../../multiDiffEditor/browser/scmMultiDiffAction.js';
import { repositoryFileUri, resolveGitChangeInputs } from './gitChangeEditorInput.js';
import { createScmMergeEditorInput } from '../../scm/browser/scmMergeEditorInput.js';
import type { ISCMConflictProvider, ISCMInput, ISCMProvider, ISCMResource, ISCMResourceGroup, ISCMService, ISCMStatusBarCommand, ISCMViewService } from '../../scm/common/scm.js';
import { GitSwitchBranchCommandId } from '../common/gitCommands.js';
import { gitErrorMessage } from '../common/gitError.js';
import type { GitChangeFileComparison, GitChangeStatus, GitHead, GitRepository, GitRepositoryChange, GitStatus, IGitService } from '../common/gitService.js';
import { GitHistoryProvider } from './gitHistoryProvider.js';

type ChangeSide = 'index' | 'worktree';
type PathAction = 'stage' | 'unstage' | 'discard';

export interface GitSCMProviderServices {
	readonly commandService: ICommandService;
	readonly dialogService: IDialogService;
	readonly editorService: IEditorService;
	readonly viewsService: IViewsService;
	readonly workingCopyService: IWorkingCopyService;
}

/** Owns Git state and operations exposed through one SCM repository. */
export class GitSCMProvider extends Disposable implements ISCMProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeResources = this.changeEmitter.event;
	public readonly id: string;
	public readonly providerId = 'git';
	public readonly label: string;
	public readonly rootUri: GitRepository['root'];
	public readonly input: ISCMInput;
	public readonly mergeProvider: ISCMConflictProvider;
	private status: GitStatus | undefined;
	private resourceGroups: readonly ISCMResourceGroup[] = [];
	private readonly retiredStreams = new Set<string>();
	private requestRevision = 0;
	private busy = false;
	private message = 'Reading Git status…';

	constructor(
		private readonly gitService: IGitService,
		repository: GitRepository,
		public readonly historyProvider: GitHistoryProvider,
		private readonly services: GitSCMProviderServices,
	) {
		super();
		this.id = repository.id;
		this.label = repository.label;
		this.rootUri = repository.root;
		const provider = this;
		this.input = {
			value: '',
			placeholder: 'Message (Ctrl+Enter to commit)',
			get enabled() { return provider.status !== undefined && !provider.busy; },
			get canAccept() { return provider.status?.changes.some(change => !change.conflicted && change.indexStatus !== 'unmodified') === true; },
			buttonLabel: 'Commit',
			buttonTooltip: 'Commit staged changes',
			accept: () => this.commit(),
		};
		this.mergeProvider = {
			resolve: path => this.gitService.conflictFile(path, this.id),
			complete: async (path, stageIds, resultObjectId, resolution) => {
				this.acceptStatus(await this.gitService.completeConflict(path, stageIds, resultObjectId, resolution, this.id));
			},
			errorMessage: gitErrorMessage,
		};
		this._register(gitService.onDidChangeRepositoryStatus(status => {
			if (status.repositoryId === this.id) this.acceptStatus(status);
		}));
		this._register(gitService.onDidBecomeReady(() => { void this.refresh(); }));
		void this.refresh();
	}

	public get isBusy(): boolean { return this.busy; }
	public get statusMessage(): string { return this.message; }
	public get activeRepositoryName(): string | undefined {
		const head = this.status?.head;
		return head?.type === 'detached' ? head.objectId : head?.name;
	}

	public get statusBarCommands(): readonly ISCMStatusBarCommand[] {
		const head = this.status?.head;
		if (!head) return [];
		const branch = branchCommand(head, this.id, this.services.commandService);
		const sync = syncCommand(head, this.services.viewsService);
		return [branch, sync];
	}

	public get groups(): readonly ISCMResourceGroup[] { return this.resourceGroups; }

	private createGroups(status: GitStatus): readonly ISCMResourceGroup[] {
		const conflicts = status.changes.filter(change => change.conflicted);
		const staged = status.changes.filter(change => !change.conflicted && change.indexStatus !== 'unmodified');
		const working = status.changes.filter(change => !change.conflicted && change.worktreeStatus !== 'unmodified');
		return [
			this.group(status, 'merge', 'Merge Changes', conflicts, 'worktree'),
			this.group(status, 'staged', 'Staged Changes', staged, 'index'),
			this.group(status, 'changes', 'Changes', working, 'worktree'),
		].filter(group => group.resources.length > 0);
	}

	public async activate(): Promise<void> {
		this.setBusy(true, 'Switching repository…');
		try {
			this.acceptStatus(await this.gitService.selectRepository(this.id));
			if (this.status) this.setMessage(statusSummary(this.status));
		} catch (error) {
			this.showError(error);
			throw error;
		} finally {
			this.setBusy(false);
		}
	}

	public async refresh(): Promise<void> {
		const requestRevision = ++this.requestRevision;
		try {
			const status = await this.gitService.status(this.id);
			if (!this.isDisposed && requestRevision === this.requestRevision) this.acceptStatus(status);
		} catch (error) {
			if (!this.isDisposed && requestRevision === this.requestRevision) {
				this.status = undefined;
				this.resourceGroups = [];
				this.showError(error);
			}
		}
	}

	private acceptStatus(status: GitStatus): void {
		if (this.isDisposed || status.repositoryId !== this.id) return;
		if (this.status) {
			// A restarted stream begins at a fresh revision; retired stream IDs must never become current again.
			if (status.streamInstanceId === this.status.streamInstanceId) {
				if (status.revision <= this.status.revision) return;
			} else {
				if (this.retiredStreams.has(status.streamInstanceId)) return;
				this.retiredStreams.add(this.status.streamInstanceId);
			}
		}
		this.requestRevision += 1;
		this.status = status;
		this.resourceGroups = this.createGroups(status);
		this.message = statusSummary(status);
		this.changeEmitter.fire();
	}

	private group(status: GitStatus, id: string, label: string, changes: readonly GitRepositoryChange[], side: ChangeSide): ISCMResourceGroup {
		const actions: IAction[] = [];
		if (changes.some(change => !change.conflicted)) actions.push(this.action(`scm.section.viewAll.${side}.${id}`, `View All ${label}`, Lxicon.codeReview, () => this.openChanges(status, label, changes, side)));
		if (side === 'index') {
			actions.push(this.pathAction('scm.section.unstageAll', 'Unstage All Changes', 'unstage', uniquePaths(changes.flatMap(changePaths))));
		} else {
			const discardable = changes.filter(isDiscardable).map(change => change.path);
			if (discardable.length > 0) actions.push(this.pathAction('scm.section.discardAll', 'Discard All Changes', 'discard', uniquePaths(discardable)));
			actions.push(this.pathAction(`scm.section.stageAll.${id}`, id === 'merge' ? 'Stage All Merge Changes' : 'Stage All Changes', 'stage', uniquePaths(changes.flatMap(changePaths))));
		}
		return { id, label, resources: changes.map(change => this.resource(status, change, side)), actions };
	}

	private resource(status: GitStatus, change: GitRepositoryChange, side: ChangeSide): ISCMResource {
		const state = side === 'index' ? change.indexStatus : change.worktreeStatus;
		const actions = side === 'index'
			? [this.pathAction(`scm.change.unstage.${change.path}`, `Unstage ${change.path}`, 'unstage', changePaths(change))]
			: [
				...(isDiscardable(change) ? [this.pathAction(`scm.change.discard.${change.path}`, `Discard ${change.path}`, 'discard', [change.path])] : []),
				this.pathAction(`scm.change.stage.${change.path}`, `Stage ${change.path}`, 'stage', changePaths(change)),
			];
		return {
			sourceUri: repositoryFileUri(status.workspacePath, change.path),
			path: change.path,
			originalPath: change.originalPath,
			decorations: { badge: statusCode(state), tooltip: statusLabel(state), kind: state },
			openLabel: change.conflicted ? `Open merge conflict in ${change.path}` : `Open ${side === 'index' ? 'staged changes' : 'changes'} for ${change.path}`,
			actions,
			open: ({ pinned }) => this.openChange(status, change, side, pinned),
		};
	}

	private action(id: string, label: string, icon: IAction['icon'], run: () => Promise<void>): IAction {
		return { id, label, tooltip: label, icon, enabled: true, checked: undefined, run: () => { void this.runAction(run); } };
	}

	private pathAction(id: string, label: string, action: PathAction, paths: readonly string[]): IAction {
		const icon = action === 'stage' ? Lxicon.add : action === 'unstage' ? Lxicon.remove : Lxicon.discard;
		return { id, label, tooltip: label, icon, enabled: true, checked: undefined, run: () => { void this.mutatePaths(action, paths); } };
	}

	private async runAction(run: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.setBusy(true);
		try { await run(); } catch (error) { this.showError(error); } finally { this.setBusy(false); }
	}

	private async mutatePaths(action: PathAction, paths: readonly string[]): Promise<void> {
		if (this.busy) return;
		const status = this.status;
		if (!status || paths.length === 0) return;
		if (action === 'stage') {
			const dirty = status.changes.filter(change => change.conflicted && paths.includes(change.path) && this.services.workingCopyService.get(repositoryFileUri(status.workspacePath, change.path)).some(copy => copy.isDirty));
			if (dirty.length > 0) {
				this.setMessage(dirty.length === 1 ? `Save ${dirty[0].path} before staging its conflict resolution.` : `Save ${dirty.length} conflicted files before staging their resolutions.`);
				return;
			}
		}
		if (action === 'discard') {
			const target = paths.length === 1 ? paths[0] : `${paths.length} working-tree files`;
			const decision = await this.services.dialogService.confirm({ message: `Discard changes in ${target}? This cannot be undone.` });
			if (!decision.confirmed || this.status !== status) return;
		}
		await this.runAction(async () => {
			this.setMessage(`${action === 'stage' ? 'Staging' : action === 'unstage' ? 'Unstaging' : 'Discarding'} ${paths.length === 1 ? paths[0] : `${paths.length} paths`}…`);
			const result = action === 'stage' ? await this.gitService.stage(paths, this.id) : action === 'unstage' ? await this.gitService.unstage(paths, this.id) : await this.gitService.discardWorktree(paths, this.id);
			this.acceptStatus(result);
		});
	}

	private async commit(): Promise<string | undefined> {
		const message = this.input.value.trim();
		if (!message) {
			this.setMessage('Enter a commit message.');
			return undefined;
		}
		let resultId: string | undefined;
		await this.runAction(async () => {
			this.setMessage('Committing staged changes…');
			const result = await this.gitService.commit(message, this.id);
			resultId = result.objectId;
			this.input.value = '';
			this.acceptStatus(result.status);
			this.setMessage(`Created commit ${result.objectId.slice(0, 7)}. ${this.message}`);
		});
		return resultId;
	}

	private async openChange(status: GitStatus, change: GitRepositoryChange, side: ChangeSide, pinned: boolean): Promise<void> {
		try {
			if (change.conflicted) {
				const resource = URI.parse(`git-merge:/${encodeURIComponent(this.id)}/${change.path.split('/').map(encodeURIComponent).join('/')}`);
				await this.services.editorService.openEditor(createScmMergeEditorInput(this.id, change.path, resource, repositoryFileUri(status.workspacePath, change.path)), { pinned });
				return;
			}
			const comparison: GitChangeFileComparison = side === 'index' ? 'staged' : 'unstaged';
			const inputs = await resolveGitChangeInputs(this.gitService, status, change, comparison);
			if (inputs.original && inputs.modified) await this.services.editorService.openEditor(createDiffEditorInput(inputs.original, inputs.modified, `${inputs.original.label} ↔ ${inputs.modified.label}`), { pinned });
			else if (inputs.modified) await this.services.editorService.openEditor(inputs.modified, { pinned });
			else if (inputs.original) await this.services.editorService.openEditor(inputs.original, { pinned });
		} catch (error) { this.showError(error); }
	}

	private async openChanges(status: GitStatus, title: string, changes: readonly GitRepositoryChange[], side: ChangeSide): Promise<void> {
		const options: OpenScmMultiDiffEditorOptions = { title, comparison: side === 'index' ? 'staged' : 'unstaged', status, changes };
		const result = await this.services.commandService.executeCommand<OpenScmMultiDiffEditorResult>(OpenScmMultiDiffEditorCommandId, options);
		if (result === 'empty' && this.status === status) this.setMessage(`No text changes are available in ${title}.`);
	}

	private showError(error: unknown): void { this.setMessage(gitErrorMessage(error)); }
	private setMessage(message: string): void { this.message = message; this.changeEmitter.fire(); }
	private setBusy(busy: boolean, message?: string): void {
		this.busy = busy;
		if (message) this.message = message;
		this.changeEmitter.fire();
	}
}

/** Keeps the SCM registry in sync with Git repositories in this Workbench window. */
export class GitSCMContribution extends Disposable {
	private readonly providers = this._register(new DisposableMap<string, DisposableStore>());

	constructor(private readonly gitService: IGitService, private readonly scmService: ISCMService, private readonly scmViewService: ISCMViewService, private readonly services: GitSCMProviderServices) {
		super();
		this._register(gitService.onDidChangeRepositories(() => this.syncRepositories()));
		this._register(gitService.onDidChangeActiveRepository(() => this.syncSelection()));
		this._register(gitService.onDidBecomeReady(() => this.syncRepositories()));
		this.syncRepositories();
	}

	private syncRepositories(): void {
		const current = new Set(this.gitService.repositories.map(repository => repository.id));
		for (const id of this.providers.keys()) if (!current.has(id)) this.providers.deleteAndDispose(id);
		for (const repository of this.gitService.repositories) {
			if (this.providers.has(repository.id)) continue;
			const store = new DisposableStore();
			const history = store.add(new GitHistoryProvider(this.gitService, repository.id));
			const provider = store.add(new GitSCMProvider(this.gitService, repository, history, this.services));
			store.add(this.scmService.registerSCMProvider(provider));
			this.providers.set(repository.id, store);
		}
		this.syncSelection();
	}

	private syncSelection(): void {
		const activeId = this.gitService.activeRepository?.id;
		if (activeId && this.scmService.getRepository(activeId)) this.scmViewService.selectRepository(activeId);
		else if (this.scmViewService.activeRepository?.provider.providerId === 'git') this.scmViewService.selectRepository(undefined);
	}
}

function branchCommand(head: GitHead, repositoryId: string, commandService: ICommandService): ISCMStatusBarCommand {
	const shared = { id: 'ash.status.git.branch', priority: 900, compactGroup: 'ash.status.git', run: () => commandService.executeCommand(GitSwitchBranchCommandId, repositoryId) };
	switch (head.type) {
		case 'branch': return { ...shared, icon: Lxicon.gitBranch, text: head.name, ariaLabel: `Git branch ${head.name}`, tooltip: head.upstream ? `${head.name} tracks ${head.upstream.name}` : `${head.name} has no upstream` };
		case 'unborn': return { ...shared, icon: Lxicon.gitBranch, text: head.name, ariaLabel: `Unborn Git branch ${head.name}`, tooltip: `${head.name} has no commits` };
		case 'detached': {
			const revision = head.objectId.slice(0, 8);
			return { ...shared, icon: Lxicon.gitCommit, text: revision, ariaLabel: `Detached Git HEAD at ${revision}`, tooltip: `Detached HEAD at ${head.objectId}` };
		}
	}
}

function syncCommand(head: GitHead, viewsService: IViewsService): ISCMStatusBarCommand {
	const shared = { id: 'ash.status.git.sync', priority: 800, compactGroup: 'ash.status.git', run: () => viewsService.focusView('ash.gitView') };
	if (head.type !== 'branch') return { ...shared, icon: Lxicon.sync, text: '', ariaLabel: 'No Git branch to synchronize', tooltip: 'No Git branch to synchronize' };
	if (!head.upstream) return { ...shared, icon: Lxicon.repoPush, text: '', ariaLabel: `Publish Git branch ${head.name}`, tooltip: `${head.name} has no upstream` };
	const { ahead, behind, name } = head.upstream;
	const summary = `${behind} incoming and ${ahead} outgoing ${ahead + behind === 1 ? 'change' : 'changes'}`;
	return { ...shared, icon: Lxicon.sync, text: ahead === 0 && behind === 0 ? '' : `${behind}↓ ${ahead}↑`, ariaLabel: `Synchronize Git changes, ${summary}`, tooltip: `Synchronize Changes with ${name}: ${summary}` };
}

function changePaths(change: GitRepositoryChange): string[] { return change.originalPath ? [change.originalPath, change.path] : [change.path]; }
function statusSummary(status: GitStatus): string { return status.changes.length === 0 ? 'No changes.' : `${status.changes.length} changed ${status.changes.length === 1 ? 'file' : 'files'}`; }
function uniquePaths(paths: readonly string[]): string[] { return [...new Set(paths)]; }
function isDiscardable(change: GitRepositoryChange): boolean { return !change.conflicted && ['modified', 'deleted', 'typeChanged'].includes(change.worktreeStatus); }
function statusLabel(status: GitChangeStatus): string { return status.replace(/([A-Z])/g, ' $1').toLowerCase(); }
function statusCode(status: GitChangeStatus): string {
	switch (status) {
		case 'modified': return 'M'; case 'added': return 'A'; case 'deleted': return 'D'; case 'renamed': return 'R'; case 'copied': return 'C';
		case 'typeChanged': return 'T'; case 'unmerged': return '!'; case 'untracked': return 'U'; case 'ignored': return 'I'; case 'unmodified': return '';
	}
}
