import type { IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IDecorationsService, type IDecorationData, type IDecorationsProvider } from '../../../services/decorations/common/decorations.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IViewsService } from '../../../services/views/common/viewsService.js';
import type { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { OpenScmMultiDiffEditorCommandId, type OpenScmMultiDiffEditorOptions, type OpenScmMultiDiffEditorResult } from '../../multiDiffEditor/browser/scmMultiDiffAction.js';
import { repositoryFileUri, resolveGitChangeInputs } from './gitChangeEditorInput.js';
import { createScmMergeEditorInput } from '../../scm/browser/scmMergeEditorInput.js';
import type { ISCMConflictProvider, ISCMInput, ISCMProvider, ISCMResource, ISCMResourceGroup, ISCMService, ISCMStatusBarCommand, ISCMViewService } from '../../scm/common/scm.js';
import { GitSwitchBranchCommandId } from '../common/gitCommands.js';
import { gitErrorMessage } from '../common/gitError.js';
import type { GitChangeFileComparison, GitChangeStatus, GitCommitOptions, GitHead, GitRepository, GitRepositoryChange, GitStatus, IGitService } from '../common/gitService.js';
import { GitHistoryProvider } from './gitHistoryProvider.js';

type ChangeSide = 'index' | 'worktree';
type PathAction = 'stage' | 'unstage' | 'discard';

const modifiedForeground = registerColor('gitDecoration.modifiedResourceForeground', { dark: '#e2c08d', light: '#895503', hcDark: foreground, hcLight: foreground }, { description: 'Foreground color for files modified in Git.', owner: 'git.decorations' });
const addedForeground = registerColor('gitDecoration.addedResourceForeground', { dark: '#81b88b', light: '#587c0c', hcDark: foreground, hcLight: foreground }, { description: 'Foreground color for files added in Git.', owner: 'git.decorations' });
const deletedForeground = registerColor('gitDecoration.deletedResourceForeground', { dark: '#c74e39', light: '#ad0707', hcDark: foreground, hcLight: foreground }, { description: 'Foreground color for files deleted in Git.', owner: 'git.decorations' });
const renamedForeground = registerColor('gitDecoration.renamedResourceForeground', { dark: '#73c991', light: '#007100', hcDark: foreground, hcLight: foreground }, { description: 'Foreground color for files renamed in Git.', owner: 'git.decorations' });
const untrackedForeground = registerColor('gitDecoration.untrackedResourceForeground', { dark: '#73c991', light: '#007100', hcDark: foreground, hcLight: foreground }, { description: 'Foreground color for untracked files in Git.', owner: 'git.decorations' });
const conflictingForeground = registerColor('gitDecoration.conflictingResourceForeground', { dark: '#e4676b', light: '#ad0707', hcDark: foreground, hcLight: foreground }, { description: 'Foreground color for files with Git conflicts.', owner: 'git.decorations' });

export interface GitSCMProviderServices {
	readonly commandService: ICommandService;
	readonly dialogService: IDialogService;
	readonly editorService: IEditorService;
	readonly viewsService: IViewsService;
	readonly workingCopyService: IWorkingCopyService;
}

/** Owns Git state and operations exposed through one SCM repository. */
export class GitSCMProvider extends Disposable implements ISCMProvider, IDecorationsProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeResources = this.changeEmitter.event;
	private readonly decorationChangeEmitter = this._register(new Emitter<readonly URI[]>());
	public readonly onDidChange = this.decorationChangeEmitter.event;
	private readonly decorations = new Map<string, { readonly resource: URI; readonly data: IDecorationData; }>();
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
	private inputValue = '';
	private inputRevision = 0;
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
			get value() { return provider.inputValue; },
			set value(value: string) {
				// Rendering writes the model text back; only a changed draft advances its version.
				if (provider.inputValue !== value) { provider.inputValue = value; provider.inputRevision++; }
			},
			get placeholder() {
				const shortcut = isMacintosh ? '⌘Enter' : 'Ctrl+Enter';
				const branch = provider.status?.head;
				return branch && branch.type !== 'detached'
					? localize('git.commitMessageOnBranch', 'Message ({0} to commit on "{1}")', shortcut, branch.name)
					: localize('git.commitMessage', 'Message ({0} to commit)', shortcut);
			},
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

	public provideDecorations(resource: URI): IDecorationData | undefined {
		return this.decorations.get(extUriBiasedIgnorePathCase.getComparisonKey(resource))?.data;
	}

	private updateDecorations(): void {
		const affected = new Map([...this.decorations].map(([key, value]) => [key, value.resource]));
		this.decorations.clear();
		// Working-tree entries follow staged entries: a shared file label describes the live file,
		// while SCM rows keep the independent status for each side of the index.
		for (const group of this.resourceGroups) {
			for (const resource of group.resources) {
				const data = statusDecoration(resource.decorations.kind as GitChangeStatus);
				const key = extUriBiasedIgnorePathCase.getComparisonKey(resource.sourceUri);
				this.decorations.set(key, { resource: resource.sourceUri, data });
				affected.set(key, resource.sourceUri);
			}
		}
		for (const { resource, data } of [...this.decorations.values()]) {
			let parent = extUriBiasedIgnorePathCase.dirname(resource);
			while (extUriBiasedIgnorePathCase.isEqualOrParent(parent, this.rootUri)) {
				const key = extUriBiasedIgnorePathCase.getComparisonKey(parent);
				if ((this.decorations.get(key)?.data.weight ?? -1) < data.weight!) {
					this.decorations.set(key, { resource: parent, data: { color: data.color, weight: data.weight, tooltip: localize('git.containsChanges', 'Contains Git changes') } });
				}
				affected.set(key, parent);
				if (extUriBiasedIgnorePathCase.isEqual(parent, this.rootUri)) break;
				parent = extUriBiasedIgnorePathCase.dirname(parent);
			}
		}
		this.decorationChangeEmitter.fire([...affected.values()]);
	}

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
				this.updateDecorations();
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
		this.updateDecorations();
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
		const state = change.conflicted ? 'unmerged' : side === 'index' ? change.indexStatus : change.worktreeStatus;
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
			open: (options, sideBySide) => this.openChange(status, change, side, options, sideBySide),
		};
	}

	private action(id: string, label: string, icon: IAction['icon'], run: () => Promise<void>): IAction {
		return { id, label, tooltip: label, icon, enabled: true, checked: undefined, run: () => { void this.runAction(run); } };
	}

	private pathAction(id: string, label: string, action: PathAction, paths: readonly string[]): IAction {
		const icon = action === 'stage' ? Lxicon.add : action === 'unstage' ? Lxicon.remove : Lxicon.discard;
		return { id, label, tooltip: label, icon, enabled: true, checked: undefined, run: () => { void this.mutatePaths(action, paths); } };
	}

	public async runTitleOperation(operation: () => Promise<unknown>): Promise<void> {
		await this.runAction(async () => { await operation(); });
	}

	public async stageAll(): Promise<void> {
		const changes = this.status?.changes.filter(change => change.conflicted || change.worktreeStatus !== 'unmodified') ?? [];
		await this.mutatePaths('stage', uniquePaths(changes.flatMap(changePaths)));
	}

	public async unstageAll(): Promise<void> {
		const changes = this.status?.changes.filter(change => !change.conflicted && change.indexStatus !== 'unmodified') ?? [];
		await this.mutatePaths('unstage', uniquePaths(changes.flatMap(changePaths)));
	}

	public async discardAll(): Promise<void> {
		const changes = this.status?.changes.filter(isDiscardable) ?? [];
		await this.mutatePaths('discard', uniquePaths(changes.map(change => change.path)));
	}

	private async runAction(run: () => Promise<void>): Promise<void> {
		if (this.busy || this.isDisposed) return;
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

	public async commit(options: GitCommitOptions = {}, chooseScope?: () => Promise<GitCommitOptions['scope']>): Promise<string | undefined> {
		let resultId: string | undefined;
		await this.runAction(async () => {
			let revision = this.inputRevision;
			let message = this.input.value.trim();
			const commitOptions = { ...options };
			if (chooseScope) {
				const scope = await chooseScope();
				if (!scope || this.isDisposed || this.inputRevision !== revision) return;
				commitOptions.scope = scope;
			}
			if (commitOptions.mode === 'amend') {
				const head = this.status?.head;
				if (!head || head.type === 'unborn') {
					this.setMessage(localize('git.noCommitToAmend', 'There is no commit to amend.'));
					return;
				}
				commitOptions.expectedHead = head;
				if (!message) {
					const previous = await this.gitService.commitMessage(head.objectId, this.id);
					if (this.isDisposed || this.inputRevision !== revision) return;
					if (!this.validateAmendTarget(head)) { return; }
					this.input.value = previous;
					revision = this.inputRevision;
					message = previous.trim();
					this.changeEmitter.fire();
				}
				const confirmed = await this.services.dialogService.confirm({
					title: localize('git.confirmOperation', 'Confirm Git Operation'),
					message: localize('git.amendConfirm', 'Replace the last commit with the selected changes and this message? This rewrites commit history.'),
					primaryButton: localize('git.confirmOperationButton', 'Continue'),
				});
				if (!confirmed.confirmed || this.isDisposed || this.inputRevision !== revision) return;
				if (!this.validateAmendTarget(head)) { return; }
			}
			if (!message) {
				this.setMessage(localize('git.commitMessageRequired', 'Enter a commit message.'));
				return;
			}
			try {
				this.setMessage(localize('git.committing', 'Committing selected changes…'));
				const result = await this.gitService.commit(message, this.id, commitOptions);
				if (this.isDisposed) return;
				resultId = result.objectId;
				// A later edit, even one restoring the same text, belongs to the next commit.
				if (this.inputRevision === revision) this.input.value = '';
				this.acceptStatus(result.status);
				this.setMessage(localize('git.commitCreated', 'Created commit {0}. {1}', result.objectId.slice(0, 7), this.message));
			} catch (error) {
				// An all-changes commit can stage successfully before commit creation fails.
				await this.refresh();
				throw error;
			}
		});
		return resultId;
	}

	private validateAmendTarget(expected: GitHead): boolean {
		const current = this.status?.head;
		const matches = current && current.type !== 'unborn' && expected.type !== 'unborn' && current.type === expected.type && current.objectId === expected.objectId && (current.type !== 'branch' || expected.type === 'branch' && current.name === expected.name);
		if (matches) { return true; }
		this.setMessage(localize('git.amendHeadChanged', 'The commit or branch changed while confirming Amend. Review the current commit and retry.'));
		return false;
	}

	public async undoCommit(): Promise<void> {
		await this.runAction(async () => {
			const head = this.status?.head;
			if (!head || head.type === 'unborn') return;
			const revision = this.inputRevision;
			const restoreMessage = !this.input.value.trim();
			const message = await this.gitService.commitMessage(head.objectId, this.id);
			if (this.isDisposed) return;
			const decision = await this.services.dialogService.confirm({
				title: localize('git.confirmOperation', 'Confirm Git Operation'),
				message: localize('git.undoCommitConfirm', 'Undo commit {0} and keep its changes staged? This rewrites commit history.', head.objectId.slice(0, 8)),
				primaryButton: localize('git.confirmOperationButton', 'Continue'),
			});
			if (!decision.confirmed || this.isDisposed) return;
			const result = await this.gitService.executeCommand({ kind: 'undoCommit', expectedHead: head.objectId }, this.id);
			if (this.isDisposed) return;
			const messageRestored = restoreMessage && this.inputRevision === revision;
			if (messageRestored) this.input.value = message;
			this.acceptStatus(result.status);
			this.setMessage(messageRestored
				? localize('git.undoMessageRestored', 'Last commit undone. Its message is ready to edit in Source Control.')
				: localize('git.undoDraftKept', 'Last commit undone. Your current Source Control draft was kept.'));
		});
	}

	private async openChange(status: GitStatus, change: GitRepositoryChange, side: ChangeSide, options: IEditorOptions, sideBySide: boolean): Promise<void> {
		const target = sideBySide ? 'sideGroup' : undefined;
		try {
			if (change.conflicted) {
				const resource = URI.parse(`git-merge:/${encodeURIComponent(this.id)}/${change.path.split('/').map(encodeURIComponent).join('/')}`);
				await this.services.editorService.openEditor(createScmMergeEditorInput(this.id, change.path, resource, repositoryFileUri(status.workspacePath, change.path)), options, target);
				return;
			}
			const comparison: GitChangeFileComparison = side === 'index' ? 'staged' : 'unstaged';
			const inputs = await resolveGitChangeInputs(this.gitService, status, change, comparison);
			if (inputs.original && inputs.modified) await this.services.editorService.openEditor(createDiffEditorInput(inputs.original, inputs.modified, `${inputs.original.label} ↔ ${inputs.modified.label}`), options, target);
			else if (inputs.modified) await this.services.editorService.openEditor(inputs.modified, options, target);
			else if (inputs.original) await this.services.editorService.openEditor(inputs.original, options, target);
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

	constructor(private readonly gitService: IGitService, private readonly scmService: ISCMService, private readonly scmViewService: ISCMViewService, private readonly services: GitSCMProviderServices, @IDecorationsService private readonly decorationsService: IDecorationsService) {
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
			store.add(this.decorationsService.registerDecorationsProvider(provider));
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
function statusLabel(status: GitChangeStatus): string {
	switch (status) {
		case 'modified': return localize('git.status.modified', 'Modified');
		case 'added': return localize('git.status.added', 'Added');
		case 'deleted': return localize('git.status.deleted', 'Deleted');
		case 'renamed': return localize('git.status.renamed', 'Renamed');
		case 'copied': return localize('git.status.copied', 'Copied');
		case 'typeChanged': return localize('git.status.typeChanged', 'Type changed');
		case 'unmerged': return localize('git.status.unmerged', 'Merge conflict');
		case 'untracked': return localize('git.status.untracked', 'Untracked');
		case 'ignored': return localize('git.ignored', 'Ignored by Git');
		case 'unmodified': return '';
	}
}

function statusDecoration(status: GitChangeStatus): IDecorationData {
	let color = modifiedForeground;
	switch (status) {
		case 'added': case 'copied': color = addedForeground; break;
		case 'deleted': color = deletedForeground; break;
		case 'renamed': color = renamedForeground; break;
		case 'untracked': color = untrackedForeground; break;
		case 'unmerged': color = conflictingForeground; break;
	}
	return { color, letter: statusCode(status), tooltip: statusLabel(status), weight: status === 'unmerged' ? 100 : 10, strikethrough: status === 'deleted', bubble: true };
}
function statusCode(status: GitChangeStatus): string {
	switch (status) {
		case 'modified': return 'M'; case 'added': return 'A'; case 'deleted': return 'D'; case 'renamed': return 'R'; case 'copied': return 'C';
		case 'typeChanged': return 'T'; case 'unmerged': return '!'; case 'untracked': return 'U'; case 'ignored': return 'I'; case 'unmodified': return '';
	}
}
