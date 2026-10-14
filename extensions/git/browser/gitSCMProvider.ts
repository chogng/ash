import type { IResourceEditorInput } from '../../../sdk/browser/index.js';
import type { IAction } from '../../../sdk/browser/index.js';
import { Emitter } from './support.js';
import { Lxicon } from './support.js';
import { Disposable, DisposableMap, DisposableStore } from './support.js';
import { URI } from './support.js';
import { extUriBiasedIgnorePathCase } from './support.js';
import { localize } from './support.js';
import { isMacintosh } from './support.js';
import type { IDecorationData, IDecorationsProvider } from './support.js';
import type { IEditorOptions } from '../../../sdk/browser/index.js';
import { createDiffEditorInput } from './editorInputs.js';
import { OpenScmMultiDiffEditorCommandId, type OpenScmMultiDiffEditorOptions, type OpenScmMultiDiffEditorResult } from './multiDiff.js';
import { repositoryFileUri, resolveGitChangeInputs } from './gitChangeEditorInput.js';
import { createScmMergeEditorInput } from './editorInputs.js';
import type { ISCMConflictProvider, ISCMInput, ISCMProvider, ISCMResource, ISCMResourceGroup, ISCMStatusBarCommand } from '../../../sdk/browser/index.js';
import { GitSwitchBranchCommandId } from './commandIds.js';
import type { CommandClient, DialogClient, EditorClient, ViewsClient, WorkingCopyClient } from './editors.js';
import { gitErrorMessage } from './gitError.js';
import { CancellationError } from './support.js';
import type { GitChangeFileComparison, GitChangeStatus, GitCommitOptions, GitHead, GitPullMode, GitRepository, GitRepositoryChange, GitStatus, IGitService } from './types.js';
import { GitHistoryProvider } from './gitHistoryProvider.js';
import type { Event } from '../../../sdk/browser/index.js';

type ChangeSide = 'index' | 'worktree';
type PathAction = 'stage' | 'unstage' | 'discard';

const modifiedForeground = 'gitDecoration.modifiedResourceForeground';
const addedForeground = 'gitDecoration.addedResourceForeground';
const deletedForeground = 'gitDecoration.deletedResourceForeground';
const renamedForeground = 'gitDecoration.renamedResourceForeground';
const untrackedForeground = 'gitDecoration.untrackedResourceForeground';
const conflictingForeground = 'gitDecoration.conflictingResourceForeground';

export interface GitSCMProviderServices {
	readonly configuration: {
		get<T>(key: string, defaultValue: T, resource?: URI): T;
		readonly onDidChange: Event<{ affectsConfiguration(section: string, resource?: URI): boolean; }>;
	};
	readonly commandService: CommandClient;
	readonly dialogService: DialogClient;
	readonly editorService: EditorClient;
	readonly viewsService: ViewsClient;
	readonly workingCopyService: WorkingCopyClient;
	notify(message: string): void;
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
	private refreshing: Promise<void> | undefined;
	private busy = false;
	private syncing = false;
	private operation: Promise<unknown> = Promise.resolve();
	private inputValue = '';
	private inputRevision = 0;
	private message = localize('git.readingStatus', 'Reading Git status…');
	private operationError: string | undefined;

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
			// Git work disables acceptance separately; users can keep composing the next draft.
			enabled: true,
			get canAccept() {
				const changes = provider.status?.changes ?? [];
				const smartScope = provider.services.configuration.get<string>('git.smartCommitChanges', 'all', provider.rootUri);
				const staged = changes.some(change => change.indexStatus !== 'unmodified');
				const unstaged = changes.some(change => change.worktreeStatus !== 'unmodified' && (smartScope === 'all' || change.worktreeStatus !== 'untracked'));
				return !changes.some(change => change.conflicted) && (staged || unstaged && (
					provider.services.configuration.get('git.enableSmartCommit', false, provider.rootUri)
					|| provider.services.configuration.get('git.suggestSmartCommit', true, provider.rootUri)));
			},
			buttonLabel: localize('git.commit', 'Commit'),
			get buttonTooltip() {
				return provider.status?.changes.some(change => change.indexStatus !== 'unmodified') ? localize('git.commitStagedTooltip', 'Commit staged changes') : localize('git.commitChangesTooltip', 'Commit changes');
			},
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
		this._register(services.configuration.onDidChange(event => {
			if (!event.affectsConfiguration('git', this.rootUri)) return;
			if (this.status) this.resourceGroups = this.createGroups(this.status);
			this.updateDecorations();
			this.changeEmitter.fire();
		}));
		void this.refresh();
	}

	public get isBusy(): boolean { return this.busy || this.syncing; }
	public get statusMessage(): string { return this.message; }
	public get activeRepositoryName(): string | undefined {
		const head = this.status?.head;
		return head?.type === 'detached' ? head.objectId : head?.name;
	}

	public get statusBarCommands(): readonly ISCMStatusBarCommand[] {
		const head = this.status?.head;
		if (!head) return [];
		const branch = branchCommand(head, this.id, this.services.commandService, this.isBusy);
		const sync = syncCommand(head, this.id, this.services.commandService, this.isBusy, this.syncing);
		return [branch, sync];
	}

	public get groups(): readonly ISCMResourceGroup[] { return this.resourceGroups; }

	public provideDecorations(resource: URI): IDecorationData | undefined {
		if (!this.services.configuration.get('git.decorations.enabled', true)) return undefined;
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
		const untrackedMode = this.services.configuration.get<string>('git.untrackedChanges', 'mixed', this.rootUri);
		const working = status.changes.filter(change => !change.conflicted && change.worktreeStatus !== 'unmodified' && (untrackedMode === 'mixed' || change.worktreeStatus !== 'untracked'));
		const untracked = untrackedMode === 'separate' ? status.changes.filter(change => !change.conflicted && change.worktreeStatus === 'untracked') : [];
		return [
			this.group(status, 'merge', localize('git.mergeChanges', 'Merge Changes'), conflicts, 'worktree'),
			this.group(status, 'staged', localize('git.stagedChanges', 'Staged Changes'), staged, 'index'),
			this.group(status, 'changes', localize('git.changes', 'Changes'), working, 'worktree'),
			this.group(status, 'untracked', localize('git.untrackedChanges', 'Untracked Changes'), untracked, 'worktree'),
		].filter(group => group.resources.length > 0);
	}

	public async activate(): Promise<void> {
		try {
			await this.queueAction(async () => {
				this.setMessage(localize('git.switchingRepository', 'Switching repository…'));
				this.acceptStatus(await this.gitService.selectRepository(this.id));
				if (this.status) this.setMessage(statusSummary(this.status));
			});
		} catch (error) {
			this.showError(error);
			throw error;
		}
	}

	/** Commands can arrive after discovery but before the first status snapshot. */
	public async whenReady(): Promise<void> {
		while (!this.status) {
			if (this.isDisposed) throw new CancellationError();
			await (this.refreshing ?? this.refresh());
			if (this.isDisposed) throw new CancellationError();
			if (!this.status && !this.refreshing) throw new Error(this.operationError ?? this.message);
		}
	}

	public refresh(): Promise<void> {
		const requestRevision = ++this.requestRevision;
		const request = this.readStatus(requestRevision).finally(() => {
			if (this.refreshing === request) this.refreshing = undefined;
		});
		this.refreshing = request;
		return request;
	}

	private async readStatus(requestRevision: number): Promise<void> {
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
		// Repository notifications keep resources current without erasing a failed operation's explanation.
		this.message = this.operationError ?? statusSummary(status);
		this.changeEmitter.fire();
	}

	private group(status: GitStatus, id: string, label: string, changes: readonly GitRepositoryChange[], side: ChangeSide): ISCMResourceGroup {
		const actions: IAction[] = [];
		if (changes.some(change => !change.conflicted)) actions.push(this.action(`scm.section.viewAll.${side}.${id}`, localize('git.viewAll', 'View All {0}', label), Lxicon.diffMultiple1, () => this.openChanges(status, label, changes, side)));
		if (side === 'index') {
			actions.push(this.pathAction('scm.section.unstageAll', localize('git.menu.unstageAll', 'Unstage All Changes'), 'unstage', uniquePaths(changes.flatMap(changePaths))));
		} else {
			const discardable = changes.filter(isDiscardable).map(change => change.path);
			if (discardable.length > 0) actions.push(this.pathAction('scm.section.discardAll', localize('git.discardAllChanges', 'Discard All Changes'), 'discard', uniquePaths(discardable)));
			actions.push(this.pathAction(`scm.section.stageAll.${id}`, id === 'merge' ? localize('git.stageAllMergeChanges', 'Stage All Merge Changes') : localize('git.stageAllChanges', 'Stage All Changes'), 'stage', uniquePaths(changes.flatMap(changePaths))));
		}
		return { id, label, resources: changes.map(change => this.resource(status, change, side)), actions };
	}

	private resource(status: GitStatus, change: GitRepositoryChange, side: ChangeSide): ISCMResource {
		const state = change.conflicted ? 'unmerged' : side === 'index' ? change.indexStatus : change.worktreeStatus;
		const actions = side === 'index'
			? [this.pathAction(`scm.change.unstage.${change.path}`, localize('git.unstagePath', 'Unstage {0}', change.path), 'unstage', changePaths(change))]
			: [
				...(isDiscardable(change) ? [this.pathAction(`scm.change.discard.${change.path}`, localize('git.discardPath', 'Discard {0}', change.path), 'discard', [change.path])] : []),
				this.pathAction(`scm.change.stage.${change.path}`, localize('git.stagePath', 'Stage {0}', change.path), 'stage', changePaths(change)),
			];
		const hasWorkingFile = change.worktreeStatus !== 'deleted' && !(change.indexStatus === 'deleted' && change.worktreeStatus === 'unmodified');
		if (hasWorkingFile && this.services.configuration.get('git.showInlineOpenFileAction', true)) {
			actions.unshift(this.action(`scm.change.openFile.${change.path}`, localize('git.openFile', 'Open File: {0}', change.path), Lxicon.goToFile, async () => {
				await this.services.editorService.openEditor({ resource: repositoryFileUri(status.workspacePath, change.path) }, { pinned: false, revealIfOpened: true, preserveFocus: false });
			}));
		}
		return {
			sourceUri: repositoryFileUri(status.workspacePath, change.path),
			path: change.path,
			originalPath: change.originalPath,
			decorations: { badge: statusCode(state), tooltip: statusLabel(state), kind: state },
			openLabel: change.conflicted ? localize('git.openConflictPath', 'Open merge conflict in {0}', change.path)
				: hasWorkingFile && !this.services.configuration.get('git.openDiffOnClick', true, this.rootUri) ? localize('git.openFile', 'Open File: {0}', change.path)
					: localize('git.openChangePath', 'Open {0} for {1}', side === 'index' ? localize('git.stagedChanges', 'Staged Changes') : localize('git.changes', 'Changes'), change.path),
			actions,
			open: (options, sideBySide) => this.openChange(status, change, side, options, sideBySide),
		};
	}

	private action(id: string, label: string, icon: IAction['icon'], run: () => Promise<void>): IAction {
		return { id, label, tooltip: label, icon, enabled: true, checked: undefined, run: () => this.runAction(run) };
	}

	private pathAction(id: string, label: string, action: PathAction, paths: readonly string[]): IAction {
		const icon = action === 'stage' ? Lxicon.add : action === 'unstage' ? Lxicon.remove : Lxicon.discard;
		return { id, label, tooltip: label, icon, enabled: true, checked: undefined, run: () => this.mutatePaths(action, paths) };
	}

	public async runTitleOperation(operation: () => Promise<GitStatus>): Promise<void> {
		await this.runAction(async () => {
			this.acceptStatus(await operation());
			if (this.status) this.setMessage(statusSummary(this.status));
		});
	}

	/** Pull before pushing, keeping both steps in the provider's repository operation queue. */
	public async sync(mode: GitPullMode = 'sync'): Promise<void> {
		if (this.isDisposed || this.isBusy) return;
		// Claim the action before the queue starts so rapid activations cannot enqueue another sync.
		this.syncing = true;
		this.changeEmitter.fire();
		try {
			await this.runAction(async () => {
				const before = await this.gitService.status(this.id);
				this.acceptStatus(before);
				if (this.isDisposed || before.head.type !== 'branch' || !before.head.upstream) return;
				if (this.services.configuration.get('git.confirmSync', true)) {
					const confirmed = await this.services.dialogService.confirm({ message: localize('git.syncConfirm', 'Pull and push commits for branch {0}?', before.head.name) });
					if (!confirmed.confirmed || this.isDisposed) return;
					const current = await this.gitService.status(this.id);
					if (!sameHead(before.head, current.head) || current.head.type !== 'branch' || current.head.upstream?.name !== before.head.upstream.name) return;
				}
				this.setMessage(localize('git.status.synchronizing', 'Synchronizing Changes…'));
				const pulled = await this.pullChanges(before, mode);
				if (!pulled) return;
				this.acceptStatus(pulled);
				// A concurrent checkout or unresolved integration must not push a different branch.
				if (this.isDisposed || pulled.head.type !== 'branch' || pulled.head.name !== before.head.name
					|| pulled.head.upstream?.name !== before.head.upstream.name || pulled.changes.some(change => change.conflicted)) return;
				this.acceptStatus(await this.gitService.push(this.id));
				this.notifyPush();
				if (this.status) this.setMessage(statusSummary(this.status));
			});
		} finally {
			this.syncing = false;
			this.changeEmitter.fire();
		}
	}

	public async pull(mode: GitPullMode = 'configured'): Promise<void> {
		await this.runAction(async () => {
			const before = await this.gitService.status(this.id);
			const pulled = await this.pullChanges(before, mode);
			if (pulled) this.acceptStatus(pulled);
		});
	}

	private async pullChanges(before: GitStatus, mode: GitPullMode): Promise<GitStatus | undefined> {
		if (this.services.configuration.get('git.fetchOnPull', false, this.rootUri)) {
			const fetched = await this.gitService.fetch(this.id, 'all');
			this.acceptStatus(fetched);
			if (this.isDisposed || !sameHead(before.head, fetched.head)) return undefined;
		}
		return this.gitService.pull(this.id, mode);
	}

	public async push(): Promise<void> {
		await this.runAction(async () => {
			this.acceptStatus(await this.gitService.push(this.id));
			this.notifyPush();
		});
	}

	private notifyPush(): void {
		if (!this.isDisposed && this.services.configuration.get('git.showPushSuccessNotification', false)) {
			this.services.notify(localize('git.pushSucceeded', 'Successfully pushed repository {0}.', this.label));
		}
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
		await this.queueAction(async () => {
			try { await run(); } catch (error) { this.showError(error); }
		});
	}

	private queueAction<T>(run: () => Promise<T>): Promise<T | undefined> {
		// Selection can still be activating when a palette command arrives. Retain the user's intent.
		const operation = this.operation.then(async () => {
			if (this.isDisposed) return undefined;
			this.operationError = undefined;
			this.setBusy(true);
			try { return await run(); } finally { this.setBusy(false); }
		});
		this.operation = operation.catch(() => undefined);
		return operation;
	}

	public async mutatePaths(action: PathAction, paths: readonly string[]): Promise<void> {
		const status = this.status;
		if (!status || paths.length === 0) return;
		if (action === 'stage') {
			const conflicts = status.changes.filter(change => change.conflicted && paths.includes(change.path));
			const checks = await Promise.all(conflicts.map(async change => ({ change, dirty: (await this.services.workingCopyService.get(repositoryFileUri(status.workspacePath, change.path))).some(copy => copy.isDirty) })));
			const dirty = checks.filter(check => check.dirty).map(check => check.change);
			if (dirty.length > 0) {
				this.setMessage(dirty.length === 1 ? localize('git.action.saveConflict', 'Save {0} before staging its conflict resolution.', dirty[0].path) : localize('git.action.saveConflicts', 'Save {0} conflicted files before staging their resolutions.', dirty.length));
				return;
			}
		}
		if (action === 'discard') {
			const target = paths.length === 1 ? paths[0] : localize('git.action.paths', '{0} paths', paths.length);
			const decision = await this.services.dialogService.confirm({ message: localize('git.action.discardConfirm', 'Discard changes in {0}? This cannot be undone.', target) });
			if (!decision.confirmed || this.status !== status) return;
		}
		await this.runAction(async () => {
			this.setMessage(localize(action === 'stage' ? 'git.action.stageProgress' : action === 'unstage' ? 'git.action.unstageProgress' : 'git.action.discardProgress', action === 'stage' ? 'Staging {0}…' : action === 'unstage' ? 'Unstaging {0}…' : 'Discarding {0}…', paths.length === 1 ? paths[0] : localize('git.action.paths', '{0} paths', paths.length)));
			const result = action === 'stage' ? await this.gitService.stage(paths, this.id) : action === 'unstage' ? await this.gitService.unstage(paths, this.id) : await this.gitService.discardWorktree(paths, this.id);
			this.acceptStatus(result);
		});
	}

	public async commit(options: GitCommitOptions = {}, chooseScope?: () => Promise<GitCommitOptions['scope']>): Promise<string | undefined> {
		let resultId: string | undefined;
		await this.runAction(async () => {
			const before = this.status;
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
			if (commitOptions.scope === undefined && commitOptions.empty !== 'allow' && commitOptions.mode !== 'amend'
				&& !this.status?.changes.some(change => !change.conflicted && change.indexStatus !== 'unmodified')) {
				if (this.services.configuration.get('git.enableSmartCommit', false, this.rootUri)) {
					commitOptions.scope = this.services.configuration.get<string>('git.smartCommitChanges', 'all', this.rootUri) === 'tracked' ? 'tracked' : 'includeUntracked';
				} else if (this.services.configuration.get('git.suggestSmartCommit', true, this.rootUri)) {
					if (!this.status?.changes.length) { this.setMessage(localize('git.noChangesToCommit', 'There are no changes to commit. Use Commit Empty to create an empty commit.')); return; }
					const confirmed = await this.services.dialogService.confirm({ message: localize('git.smartCommitConfirm', 'No changes are staged. Stage and commit the selected scope of changes?') });
					if (!confirmed.confirmed || this.isDisposed || revision !== this.inputRevision) return;
					commitOptions.scope = this.services.configuration.get<string>('git.smartCommitChanges', 'all', this.rootUri) === 'tracked' ? 'tracked' : 'includeUntracked';
				} else {
					this.setMessage(localize('git.stageBeforeCommit', 'Stage changes before committing.'));
					return;
				}
			}
			if (commitOptions.empty === 'allow' && this.services.configuration.get('git.confirmEmptyCommits', true, this.rootUri)) {
				const confirmed = await this.services.dialogService.confirm({ message: localize('git.emptyCommitConfirm', 'Create a commit even if there are no staged changes?') });
				if (!confirmed.confirmed || this.isDisposed || revision !== this.inputRevision) return;
			}
			if (commitOptions.signing === undefined && this.services.configuration.get('git.enableCommitSigning', false, this.rootUri)) commitOptions.signing = 'required';
			if (before && this.status && !sameHead(before.head, this.status.head)) {
				this.setMessage(localize('git.commitHeadChanged', 'The branch or commit changed while preparing this commit. Review the current repository and retry.'));
				return;
			}
			if (commitOptions.expectedHead === undefined && before && before.head.type !== 'unborn') commitOptions.expectedHead = before.head;
			try {
				this.setMessage(localize('git.committing', 'Committing selected changes…'));
				const result = await this.gitService.commit(message, this.id, commitOptions);
				if (this.isDisposed) return;
				resultId = result.objectId;
				// A later edit, even one restoring the same text, belongs to the next commit.
				if (this.inputRevision === revision) this.input.value = '';
				this.acceptStatus(result.status);
				this.setMessage(localize('git.commitCreated', 'Created commit {0}. {1}', result.objectId.slice(0, this.services.configuration.get('git.commitShortHashLength', 7, this.rootUri)), this.message));
			} catch (error) {
				// An all-changes commit can stage successfully before commit creation fails.
				await this.refresh();
				throw error;
			}
		});
		if (resultId && !this.isDisposed) {
			const postCommit = this.services.configuration.get<string>('git.postCommitCommand', 'none', this.rootUri);
			if (postCommit === 'push') await this.push();
			else if (postCommit === 'sync') await this.sync();
		}
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
			if (!this.services.configuration.get('git.openDiffOnClick', true, this.rootUri)
				&& change.worktreeStatus !== 'deleted' && !(change.indexStatus === 'deleted' && change.worktreeStatus === 'unmodified')) {
				await this.services.editorService.openEditor({ resource: repositoryFileUri(status.workspacePath, change.path) }, options, target);
				return;
			}
			const comparison: GitChangeFileComparison = side === 'index' ? 'staged' : 'unstaged';
			const inputs = await resolveGitChangeInputs(this.gitService, status, change, comparison);
			if (inputs.binary && inputs.original && inputs.modified) {
				await this.services.editorService.openEditor({ kind: 'multiDiff', resource: URI.from({ scheme: 'ash-multi-diff', path: `/scm/${comparison}/${change.path}` }), items: [{ label: change.path, original: inputs.original, modified: inputs.modified, binary: true, goToFile: inputs.goToFile }], label: change.path, readOnly: true } as IResourceEditorInput, options, target);
			} else if (inputs.original && inputs.modified) await this.services.editorService.openEditor(createDiffEditorInput(inputs.original, inputs.modified, `${inputs.original.label} ↔ ${inputs.modified.label}`), options, target);
			else if (inputs.modified) await this.services.editorService.openEditor(inputs.modified, options, target);
			else if (inputs.original) await this.services.editorService.openEditor(inputs.original, options, target);
		} catch (error) { this.showError(error); }
	}

	private async openChanges(status: GitStatus, title: string, changes: readonly GitRepositoryChange[], side: ChangeSide): Promise<void> {
		const options: OpenScmMultiDiffEditorOptions = { title, comparison: side === 'index' ? 'staged' : 'unstaged', status, changes };
		const result = await this.services.commandService.executeCommand<OpenScmMultiDiffEditorResult>(OpenScmMultiDiffEditorCommandId, options);
		if (result === 'empty' && this.status === status) this.setMessage(`No text changes are available in ${title}.`);
	}

	private showError(error: unknown): void { this.operationError = gitErrorMessage(error); this.setMessage(this.operationError); }
	private setMessage(message: string): void { this.message = message; this.changeEmitter.fire(); }
	private setBusy(busy: boolean, message?: string): void {
		this.busy = busy;
		if (message) this.message = message;
		this.changeEmitter.fire();
	}
}

function sameHead(left: GitHead, right: GitHead): boolean {
	if (left.type === 'unborn') return right.type === 'unborn' && left.name === right.name;
	if (left.type === 'detached') return right.type === 'detached' && left.objectId === right.objectId;
	return right.type === 'branch' && left.name === right.name && left.objectId === right.objectId;
}

function branchCommand(head: GitHead, repositoryId: string, commandService: CommandClient, busy: boolean): ISCMStatusBarCommand {
	const shared = {
		id: 'ash.status.git.branch', priority: 900, compactGroup: 'ash.status.git',
		run: busy ? undefined : () => commandService.executeCommand(GitSwitchBranchCommandId, repositoryId),
	};
	switch (head.type) {
		case 'branch': return { ...shared, icon: Lxicon.gitBranch, text: head.name, ariaLabel: localize('git.status.branch', 'Git branch {0}', head.name), tooltip: head.upstream ? localize('git.status.tracks', '{0} tracks {1}', head.name, head.upstream.name) : localize('git.status.noUpstream', '{0} has no upstream', head.name) };
		case 'unborn': return { ...shared, icon: Lxicon.gitBranch, text: head.name, ariaLabel: localize('git.status.unborn', 'Unborn Git branch {0}', head.name), tooltip: localize('git.status.noCommits', '{0} has no commits', head.name) };
		case 'detached': {
			const revision = head.objectId.slice(0, 8);
			return { ...shared, icon: Lxicon.gitCommit, text: revision, ariaLabel: localize('git.status.detached', 'Detached Git HEAD at {0}', revision), tooltip: localize('git.status.detachedTooltip', 'Detached HEAD at {0}', head.objectId) };
		}
	}
}

function syncCommand(head: GitHead, repositoryId: string, commandService: CommandClient, busy: boolean, syncing: boolean): ISCMStatusBarCommand {
	const shared = { id: 'ash.status.git.sync', priority: 800, compactGroup: 'ash.status.git' };
	if (syncing || busy) {
		const message = syncing
			? localize('git.status.synchronizing', 'Synchronizing Changes…')
			: localize('git.status.operationRunning', 'Git operation in progress…');
		return { ...shared, icon: Lxicon.sync, text: '', ariaLabel: message, tooltip: message };
	}
	if (head.type !== 'branch') return { ...shared, icon: Lxicon.sync, text: '', ariaLabel: localize('git.status.noBranch', 'No Git branch to synchronize'), tooltip: localize('git.status.noBranch', 'No Git branch to synchronize') };
	if (!head.upstream) return {
		...shared, icon: Lxicon.repoPush, text: '',
		ariaLabel: localize('git.status.publish', 'Publish Git branch {0}', head.name),
		tooltip: localize('git.status.noUpstream', '{0} has no upstream', head.name),
		run: () => commandService.executeCommand('git.publish', repositoryId),
	};
	const { ahead, behind, name } = head.upstream;
	const summary = localize(ahead + behind === 1 ? 'git.status.syncOne' : 'git.status.syncMany', ahead + behind === 1 ? '{0} incoming and {1} outgoing change' : '{0} incoming and {1} outgoing changes', behind, ahead);
	return {
		...shared, icon: Lxicon.sync, text: ahead === 0 && behind === 0 ? '' : `${behind}↓ ${ahead}↑`,
		ariaLabel: localize('git.status.sync', 'Synchronize Git changes, {0}', summary),
		tooltip: localize('git.status.syncTooltip', 'Synchronize Changes with {0}: {1}', name, summary),
		run: () => commandService.executeCommand('git.sync', repositoryId),
	};
}

function changePaths(change: GitRepositoryChange): string[] { return change.originalPath ? [change.originalPath, change.path] : [change.path]; }
function statusSummary(status: GitStatus): string { return status.changes.length === 0 ? localize('git.noChanges', 'No changes.') : localize(status.changes.length === 1 ? 'git.changedFile' : 'git.changedFiles', status.changes.length === 1 ? '{0} changed file' : '{0} changed files', status.changes.length); }
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
