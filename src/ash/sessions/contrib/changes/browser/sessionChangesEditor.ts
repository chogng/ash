import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { Dimension, h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import './media/sessionChangesEditor.css';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { hash } from '../../../../base/common/hash.js';
import { extUri, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IChatService, createThreadChangeFileResource } from '../../../../workbench/services/chat/common/chatService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { createTurnChangesSelectionInput, createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import { createThreadMultiDiffEditorInput } from '../../../../workbench/contrib/chat/browser/chatEditing/chatEditingActions.js';
import type { MultiDiffEditorInput, MultiDiffEditorInputItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { createMultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { MultiDiffEditor } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CancellationTokenSource, throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError, RunOnceScheduler } from '../../../../base/common/async.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';
import { getChangesViewMode, getCapturedTurnIds, type IChangesThreadFileItem } from '../common/changes.js';
import { chatExecutionWorkspace, matchesSessionFileChange, type ISessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { URI } from '../../../../base/common/uri.js';
import type { MultiDiffEditorViewState } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import type { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { GitRepositoryContext, GitSessionComparison } from '../../../../platform/git/common/localGitService.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from '../../../browser/agentHost/sessionProviderScopeService.js';

export type ChangesScope = 'all' | 'turn' | 'uncommitted' | 'branch';
export const ChangesScopeContext = new RawContextKey<ChangesScope>('sessions.changes.scope', 'all');
export const ChangesHasWorkspaceContext = new RawContextKey<boolean>('sessions.changes.hasWorkspace', false);

interface GitComparison {
	readonly provider: ISessionProviderScope;
	readonly directory: { readonly sessionId: string; readonly path: string; };
	readonly repository: GitRepositoryContext;
	readonly root: URI;
	readonly comparison: Exclude<GitSessionComparison, { kind: 'branches'; }>;
	readonly label: string;
}

interface SessionChangesEditorOptions {
	readonly showFileList?: boolean;
}

export const CHANGESET_REVIEW_ACTION_ID = 'changeset.review';

/** Resolves the selected conversation's changes only while its editor content is visible. */
export class SessionChangesEditor extends EditorPane implements IEditorPaneWithViewState {
	public static readonly ID = 'ash.sessions.changesEditor';
	public readonly id = SessionChangesEditor.ID;
	public readonly viewStateTypeId = 'ash.sessions.changesEditor';
	private comparison: MultiDiffEditor | undefined;
	private domNode!: HTMLDivElement;
	private messageDomNode!: HTMLParagraphElement;
	private input: IResourceEditorInput | undefined;
	private comparisonInput: MultiDiffEditorInput | undefined;
	private viewState: unknown;
	private dimension: IDimension = Dimension.Zero;
	private visible = false;
	private revision = 0;
	private inputRequest = 0;
	private readonly pending = this._register(new MutableDisposable<IDisposable & { readonly signal: AbortSignal; completion?: Promise<void>; }>());
	private readonly scopeRequest = this._register(new MutableDisposable<IDisposable>());
	private readonly uncommittedWatch = this._register(new MutableDisposable<DisposableStore>());
	private readonly uncommittedRefresh = this._register(new RunOnceScheduler(() => { void this.refreshUncommitted(); }, 4_000));
	private readonly scopeContext;
	private readonly hasWorkspace;
	private gitComparison: GitComparison | undefined;

	constructor(
		private readonly options: SessionChangesEditorOptions,
		@IChatService private readonly chat: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionChangesService private readonly changesService: ISessionChangesService,
		@IFileService private readonly files: IFileService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(SessionChangesEditor.ID, themeService, storageService);
		this.scopeContext = ChangesScopeContext.bindTo(contextKeys);
		this.hasWorkspace = ChangesHasWorkspaceContext.bindTo(contextKeys);
		if (options.showFileList) {
			getChangesViewMode(storageService);
			this._register(instantiation.get(ISessionsService).onDidChange(() => this.updateWorkspaceContext()));
		}
		this._register(chat.onDidUpdateTurnChanges(event => {
			if (!this.gitComparison && this.input?.resource.path === `/${event.sessionId}` && new URLSearchParams(this.input.resource.query).get('thread') === event.threadId) {
				void this.refresh();
			}
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
		this._register(chat.onDidUpdateThread(event => {
			if (event.update.type !== 'committed' || event.update.event.type !== 'threadHistoryMoved') { return; }
			if (!this.gitComparison && this.input?.resource.path === `/${event.sessionId}` && new URLSearchParams(this.input.resource.query).get('thread') === event.threadId) { void this.refresh(); }
		}));
	}

	public override create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-sessions-changes-editor' });
		this.messageDomNode = h(parent.ownerDocument, 'p', { className: 'ash-sessions-editor-message' });
		this.messageDomNode.setAttribute('role', 'status');
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('aria-label', localize('sessions.changes.title', 'Changes'));
		const context = this._register(this.contextKeys.createScoped(this.domNode));
		context.createKey('sessionsChangesEditorFocused', true);
		const updateHint = (): void => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsChanges);
			if (hint) {
				this.domNode.setAttribute('aria-description', hint);
			} else {
				this.domNode.removeAttribute('aria-description');
			}
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionsChanges)) {
				updateHint();
			}
		}));
		updateHint();
		this.domNode.append(this.messageDomNode);
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal);
		if (this.isDisposed) { throw canceled(); }
		if (this.input && !extUri.isEqual(this.input.resource, input.resource)) {
			this.clearInput();
		}
		if (this.input !== input) {
			this.scopeRequest.clear();
			this.gitComparison = undefined;
			this.updateUncommittedWatch();
		}
		this.input = input;
		const selection = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
		this.scopeContext.set(this.gitComparison?.comparison.kind ?? (selection && (selection.kind !== 'id' || selection.id) ? 'turn' : 'all'));
		this.updateWorkspaceContext();
		const inputRequest = ++this.inputRequest;
		let loading = this.refresh(signal);
		for (; ;) {
			const request = this.pending.value;
			try {
				await raceCancellationError(request ? raceCancellationError(loading, request.signal) : loading, signal);
				throwIfCancelled(signal);
				if (inputRequest !== this.inputRequest) { throw canceled(); }
				return;
			} catch (error) {
				const current = this.pending.value;
				// A background refresh belongs to the same open; follow it. A new setInput supersedes the caller.
				if (isCancellationError(error) && !signal.aborted && inputRequest === this.inputRequest && this.visible && current?.completion && current !== request) {
					loading = current.completion;
					continue;
				}
				if (signal.aborted && inputRequest === this.inputRequest) { this.clearInput(); }
				throw error;
			}
		}
	}

	public override clearInput(): void {
		this.inputRequest++;
		this.input = undefined;
		this.hasWorkspace.reset();
		this.scopeRequest.clear();
		this.gitComparison = undefined;
		this.updateUncommittedWatch();
		this.scopeContext.reset();
		this.clearComparison();
		this.viewState = undefined;
		this.revision++;
		this.pending.clear();
		this.domNode?.setAttribute('aria-busy', 'false');
	}

	public override dispose(): void {
		if (this.isDisposed) { return; }
		this.clearInput();
		super.dispose();
	}

	public getAccessibleContent(): string {
		return this.comparisonInput?.items.map(item => localize('sessions.changes.editorComparison', '{0}\nBefore:\n{1}\nAfter:\n{2}', item.label ?? item.modified.resource.path, item.original.initialText ?? '', item.modified.initialText ?? '')).join('\n\n')
			?? this.messageDomNode.textContent;
	}

	public override setVisible(visibility: boolean): void {
		if (!visibility && this.visible) {
			this.viewState = this.saveViewState();
		}
		super.setVisible(visibility);
		const visible = visibility;
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		this.updateUncommittedWatch();
		this.updateWorkspaceContext();
		if (this.visible) {
			void this.refresh();
		} else {
			this.revision++;
			this.scopeRequest.clear();
			this.pending.clear();
			this.clearComparison();
		}
	}

	private get hasThread(): boolean {
		return !!this.input && !!new URLSearchParams(this.input.resource.query).get('thread');
	}

	private updateWorkspaceContext(): void {
		const selection = this.options.showFileList && this.visible && this.input
			? this.instantiation.get(ISessionsService).activeSelection : undefined;
		if (selection?.kind !== 'session' || !extUri.isEqual(this.input?.resource, new SessionChangesEditorInput(selection).resource)) {
			this.hasWorkspace.set(false);
			return;
		}
		const { session, threadId } = selection.active;
		this.hasWorkspace.set(!!chatExecutionWorkspace(session, session.chats.find(chat => chat.threadId === threadId)));
	}

	public async previewCommit(): Promise<void> {
		if (!this.visible || !this.hasThread || !this.input || this.gitComparison) return;
		const cancellation = new CancellationTokenSource();
		const request = toDisposable(() => cancellation.dispose(true));
		this.scopeRequest.value = request;
		try {
			const input = this.input instanceof SessionChangesEditorInput ? this.input : new SessionChangesEditorInput(this.input.resource);
			await this.changesService.previewCommit(input.sessionResource, cancellation.token, input.changesetSelection);
		} catch (error) {
			if (!cancellation.token.isCancellationRequested) throw error;
		} finally {
			if (this.scopeRequest.value === request) this.scopeRequest.clear();
		}
	}

	public async selectScope(scope: ChangesScope, groupId: number): Promise<void> {
		const input = this.input;
		const threadId = input && new URLSearchParams(input.resource.query).get('thread');
		if (!input || !threadId || !this.visible) return;
		this.scopeRequest.clear();
		if (scope === 'all') {
			if (input instanceof SessionChangesEditorInput && input.changesetSelection) {
				this.gitComparison = undefined;
				this.updateUncommittedWatch();
				this.scopeContext.reset();
				await this.changesService.openChangesEditor(input.sessionResource, { forceReload: true }, { groupId });
			} else if (this.gitComparison) {
				await this.setGitComparison(undefined);
			}
			return;
		}
		const session = this.sessions.sessions.find(session => input.resource.path === `/${session.sessionId}`);
		if (!session) return;
		const controller = new AbortController();
		const request = toDisposable(() => controller.abort());
		this.scopeRequest.value = request;
		try {
			if (scope === 'turn') {
				const captures = await raceCancellationError(this.chat.listTurnChanges(session.sessionId, threadId), controller.signal);
				const items = getCapturedTurnIds(captures).map((turnId, index) => ({
					turnId, label: localize('sessions.changes.turn', 'Turn {0}', index + 1),
				}));
				if (!items.length) throw new Error(localize('sessions.changes.noTurns', 'No Turn changes are available.'));
				const selected = await this.pickScopeItem(items, localize('sessions.changes.chooseTurn', 'Changes from Turn'), controller.signal);
				if (!selected || controller.signal.aborted) return;
				await this.changesService.openChangesEditor(new SessionChangesEditorInput(input.resource).sessionResource, {
					changesetSelection: { kind: 'turn', turnId: selected.turnId },
				}, { groupId });
				return;
			}
			const workspace = chatExecutionWorkspace(session, session.chats.find(chat => chat.threadId === threadId));
			if (!workspace) throw new Error(localize('sessions.changes.noRepository', 'No Git repository is available in this session directory.'));
			const provider = this.instantiation.get(ISessionProviderScopeService).getScope(session.sessionId);
			const host = provider.services.host;
			const directory = { sessionId: provider.backendIdentity(session.sessionId), path: workspace.root };
			using cancellation = new CancellationTokenSource();
			using cancel = addDisposableListener(controller.signal, 'abort', () => cancellation.cancel(), { once: true });
			const repositories = await host.localGit.readRepositoryContexts(directory, cancellation.token);
			if (controller.signal.aborted) return;
			provider.assertCurrent();
			if (!repositories.length) throw new Error(localize('sessions.changes.noRepository', 'No Git repository is available in this session directory.'));
			const repository = repositories.length === 1 ? repositories[0] : (await this.pickScopeItem(repositories.map(repository => ({
				label: repository.label, description: repository.rootPath, repository,
			})), localize('sessions.changes.chooseRepository', 'Choose a session repository'), controller.signal))?.repository;
			if (!repository || controller.signal.aborted) return;
			const root = sessionWorkspaceUri(workspace).with({ path: URI.file(repository.rootPath).path });
			let comparison: GitComparison['comparison'] = { kind: 'uncommitted' };
			let label = localize('sessions.changes.uncommittedChanges', 'Uncommitted Changes');
			if (scope === 'branch') {
				const headObjectId = repository.head.objectId;
				if (!headObjectId) throw new Error(localize('sessions.changes.noHead', 'The repository has no current commit to compare.'));
				const result = await host.localGit.readSessionComparison(directory, repository.id, { kind: 'branches' }, controller.signal);
				if (controller.signal.aborted || result.kind !== 'branches') return;
				const branches = result.references.filter(ref => !ref.name.endsWith('/HEAD'));
				if (!branches.length) throw new Error(localize('sessions.changes.noBranches', 'There are no other branches to compare.'));
				const branch = await this.pickScopeItem(branches.map(ref => ({ label: ref.name, objectId: ref.objectId })),
					localize('sessions.changes.chooseComparisonBranch', 'Choose a branch to compare against'), controller.signal);
				if (!branch || controller.signal.aborted) return;
				comparison = { kind: 'branch', headObjectId, baseObjectId: branch.objectId };
				label = localize('sessions.changes.branchComparison', '{0} compared with {1}', repository.head.name || headObjectId.slice(0, 7), branch.label);
			}
			provider.assertCurrent();
			await this.setGitComparison({ provider, directory, repository, root, comparison, label });
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			if (this.scopeRequest.value === request) this.scopeRequest.clear();
		}
	}

	private async pickScopeItem<T extends IQuickPickItem>(items: readonly T[], placeholder: string, signal: AbortSignal): Promise<T | undefined> {
		if (signal.aborted) return undefined;
		using resources = new DisposableStore();
		const picker = resources.add(this.instantiation.get(IQuickInputService).createQuickPick<T>());
		picker.items = items;
		picker.ariaLabel = picker.placeholder = placeholder;
		return await new Promise<T | undefined>(resolve => {
			resources.add(picker.onDidHide(() => resolve(undefined)));
			resources.add(addDisposableListener(signal, 'abort', () => resolve(undefined), { once: true }));
			resources.add(picker.onDidAccept(() => resolve(picker.selectedItems[0])));
			picker.show();
		});
	}

	private async loadGitComparison(resource: URI, scope: GitComparison, signal: AbortSignal): Promise<MultiDiffEditorInput> {
		const { provider, directory, repository, root, comparison, label } = scope;
		provider.assertCurrent();
		const result = await provider.services.host.localGit.readSessionComparison(directory, repository.id, comparison, signal);
		provider.assertCurrent();
		if (result.kind !== 'changes') throw new TypeError('Expected Git comparison files');
		const source = resource.with({ scheme: 'ash-session-git-diff', fragment: JSON.stringify([repository.id, comparison]) });
		const items = result.files.map(file => {
			const originalPath = file.originalPath ?? file.path;
			const modifiedResource = URI.joinPath(root, file.path);
			// Two groups can compare the same worktree before and after an external edit.
			const revision = hash([file.original, file.modified]);
			return {
				id: file.path,
				label: file.originalPath ? `${file.originalPath} → ${file.path}` : file.path,
				fileList: { path: file.path },
				binary: file.original.kind === 'binary' || file.modified.kind === 'binary',
				contextKeys: { 'sessions.changesGitFile': true },
				original: {
					resource: URI.joinPath(source, originalPath).with({ query: `side=before&revision=${revision}` }),
					preferredResource: URI.joinPath(root, originalPath), readOnly: true, initialText: file.original.kind === 'text' ? file.original.text : ''
				},
				modified: {
					resource: URI.joinPath(source, file.path).with({ query: `side=after&revision=${revision}` }),
					preferredResource: modifiedResource, readOnly: true, initialText: file.modified.kind === 'text' ? file.modified.text : ''
				},
				goToFile: file.modified.kind === 'missing' ? undefined : { resource: modifiedResource },
			};
		});
		return createMultiDiffEditorInput(source, items, label);
	}

	private setGitComparison(comparison: GitComparison | undefined): Promise<void> {
		this.gitComparison = comparison;
		this.updateUncommittedWatch();
		this.scopeContext.set(comparison?.comparison.kind ?? 'all');
		this.clearComparison();
		this.viewState = undefined;
		return this.refresh();
	}

	private updateUncommittedWatch(): void {
		this.uncommittedRefresh.cancel();
		this.uncommittedWatch.clear();
		const scope = this.gitComparison;
		if (!this.visible || scope?.comparison.kind !== 'uncommitted') return;
		const watch = new DisposableStore();
		this.uncommittedWatch.value = watch;
		const root = scope.root;
		if (this.files.hasProvider(root)) watch.add(this.files.watch(root, { recursive: true, excludes: [] }));
		watch.add(this.files.onDidChangeFiles(({ resources }) => {
			if (!resources || resources.some(resource => extUriBiasedIgnorePathCase.isEqualOrParent(resource, root)
				|| extUriBiasedIgnorePathCase.isEqualOrParent(root, resource))) this.uncommittedRefresh.schedule(150);
		}));
	}

	private async refreshUncommitted(): Promise<void> {
		const watch = this.uncommittedWatch.value;
		if (!watch) return;
		const pending = this.pending.value;
		await pending?.completion;
		if (this.uncommittedWatch.value === watch && this.pending.value === pending) await this.refresh(undefined, true);
	}

	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.comparison?.layout(dimension);
	}

	public override focus(): void {
		if (this.comparisonInput) this.comparison?.focus();
		else this.domNode.focus();
	}

	public override getControl(): DiffEditorWidget | undefined {
		return this.comparison?.getControl();
	}

	public saveViewState(): unknown {
		return this.comparison?.saveViewState() ?? this.viewState ?? null;
	}

	public restoreViewState(state: unknown): void {
		if (state != null && this.comparisonInput) {
			this.comparison?.restoreViewState(state);
		}
		this.viewState = state;
	}

	/** Resolves either comparison side to its checkpoint or Turn capture; stale revisions cannot be reviewed. */
	public async getFileChange(resource: URI, options: { readonly review?: boolean; } = {}): Promise<ISessionFileChange | IChangesThreadFileItem | undefined> {
		const comparison = this.comparisonInput;
		const input = this.input;
		const item = this.findComparisonItem(resource);
		const signal = this.pending.value?.signal;
		if (this.gitComparison || !this.visible || !input || !comparison || !item || !signal) { return undefined; }
		// A cumulative comparison may start in an earlier Turn; its modified side identifies the capture being reviewed.
		const currentResource = item.modified.resource;
		if (currentResource.scheme === 'ash-thread-change') {
			const query = new URLSearchParams(currentResource.query);
			const sessionId = query.get('session')!;
			const threadId = query.get('thread')!;
			const repositoryId = query.get('repository')!;
			const summary = await raceCancellationError(this.chat.readThreadChanges(sessionId, threadId), signal);
			if (this.isDisposed || !this.visible || this.comparisonInput !== comparison || summary.revision !== query.get('revision')) { return undefined; }
			const file = summary.repositories.find(repository => repository.repositoryId === repositoryId)?.files.find(file =>
				extUri.isEqual(currentResource, createThreadChangeFileResource(sessionId, threadId, summary.revision, repositoryId, file.path).with({ query: currentResource.query })));
			if (!file) { return undefined; }
			query.delete('side');
			return {
				type: 'file', id: JSON.stringify([repositoryId, file.path]), sessionId, threadId, repositoryId, revision: summary.revision,
				uri: currentResource.with({ query: query.toString() }), originalUri: item.original.resource, modifiedUri: currentResource,
				file, insertions: file.additions, deletions: file.deletions, warnings: summary.warnings,
			};
		}
		const id = currentResource.path.split('/')[1];
		if (!id) { return undefined; }
		const sessionResource = new SessionChangesEditorInput(input.resource).sessionResource;
		const selection = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
		const changeset = selection?.kind === 'transient' ? selection.changeset : await raceCancellationError(this.changesService.resolveChangeset(sessionResource, id), signal).catch(error => {
			if (this.isDisposed || !this.visible || this.comparisonInput !== comparison) { return undefined; }
			throw error;
		});
		if (this.isDisposed || this.comparisonInput !== comparison || !changeset?.isEnabled.get() || options.review && !changeset.capabilities?.review) { return undefined; }
		return changeset.changes.get().find(change => matchesSessionFileChange(change, currentResource));
	}

	public setFileCollapsed(resource: URI, collapsed: boolean): void {
		const item = this.findComparisonItem(resource);
		if (item) { this.comparison?.setFileCollapsed(item, collapsed); }
	}

	private findComparisonItem(resource: URI): MultiDiffEditorInputItem | undefined {
		const query = new URLSearchParams(resource.query);
		const modified = query.has('side') ? resource : resource.with({ query: `${resource.query}&side=after` });
		return this.comparisonInput?.items.find(item => extUri.isEqual(item.original.resource, resource) || extUri.isEqual(item.modified.resource, resource) || extUri.isEqual(item.modified.resource, modified));
	}

	private clearComparison(): void {
		this.comparisonInput = undefined;
		this.comparison?.setFileListAvailable(false);
		this.comparison?.setVisible(false);
		this.comparison?.clearInput();
	}

	private showEmptyComparison(resource: URI): void {
		const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.clearComparison();
		this.changesService.setChangesCount(resource, 0);
		const message = this.gitComparison?.comparison.kind === 'branch'
			? localize('sessions.changes.noBranchChanges', 'There are no changes between these branches.')
			: this.gitComparison ? localize('sessions.changes.noUncommittedChanges', 'There are no uncommitted changes.')
				: localize('sessions.changes.empty', 'No changes in this conversation.');
		if (this.messageDomNode.textContent !== message) this.messageDomNode.textContent = message;
		this.messageDomNode.hidden = false;
		if (hadFocus && !this.domNode.contains(this.domNode.ownerDocument.activeElement)) this.domNode.focus();
	}

	private refresh(signal?: AbortSignal, background = false): Promise<void> {
		const loading = this.loadChanges(signal, background);
		if (this.pending.value) { this.pending.value.completion = loading; }
		return loading;
	}

	private async loadChanges(signal: AbortSignal | undefined, background: boolean): Promise<void> {
		const input = this.input;
		if (!input || !this.visible || this.isDisposed) {
			return;
		}
		const revision = ++this.revision;
		// The shared pane replaces the comparison model and restores this snapshot once it is ready.
		this.viewState = this.saveViewState();
		this.pending.clear();
		this.messageDomNode.hidden = !!this.comparisonInput;
		if (!background) this.changesService.setChangesCount(input.resource, undefined);
		const threadId = new URLSearchParams(input.resource.query).get('thread');
		if (!threadId) {
			this.messageDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			this.layout(this.dimension);
			return;
		}
		const session = this.sessions.sessions.find(session => input.resource.path === `/${session.sessionId}`);
		if (!session) {
			return;
		}
		if (!background) {
			this.messageDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
			this.messageDomNode.hidden = false;
			this.domNode.setAttribute('aria-busy', 'true');
		}
		const controller = new AbortController();
		const abortListener = signal ? addDisposableListener(signal, 'abort', () => controller.abort(), { once: true }) : undefined;
		if (signal?.aborted) { controller.abort(); }
		this.pending.value = Object.assign(toDisposable(() => {
			abortListener?.dispose();
			controller.abort();
		}), { signal: controller.signal });
		try {
			const selected = input instanceof SessionChangesEditorInput ? input.changesetSelection : undefined;
			const gitComparison = this.gitComparison;
			let comparison: MultiDiffEditorInput;
			if (gitComparison) {
				comparison = await this.loadGitComparison(input.resource, gitComparison, controller.signal);
			} else if (selected?.kind === 'transient' || selected?.kind === 'turn') {
				const read = <T>(promise: Promise<T>) => raceCancellationError(promise, controller.signal);
				const sessionResource = new SessionChangesEditorInput(input.resource).sessionResource;
				const captures = selected.kind === 'turn' ? await read(this.chat.listTurnChanges(session.sessionId, threadId)) : [];
				const changesets = selected.kind === 'transient' ? [selected.changeset] : await Promise.all(
					captures
						.filter(capture => capture.turnId === selected.turnId && capture.captureState !== 'discarded' && capture.statistics.files > 0)
						.map(capture => read(this.changesService.resolveChangeset(sessionResource, capture.changeSetId))),
				);
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				const changes = changesets.flatMap(changeset => changeset.isEnabled.get()
					? changeset.changes.get().map(change => ({ change, canReview: changeset.capabilities?.review === true })) : []);
				if (!changes.length) {
					this.showEmptyComparison(input.resource);
					return;
				}
				const label = selected.kind === 'transient' ? selected.changeset.label
					: localize('sessions.changes.turn', 'Turn {0}', getCapturedTurnIds(captures).indexOf(selected.turnId) + 1);
				const resource = selected.kind === 'transient' ? input.resource
					: input.resource.with({ scheme: 'ash-multi-diff', fragment: selected.turnId });
				comparison = await createTurnChangesSelectionInput(this.chat, resource, label, changes, controller.signal);
			} else if (!selected?.id) {
				comparison = await createThreadMultiDiffEditorInput(this.chat, session.sessionId, threadId, undefined, controller.signal);
				comparison = { ...comparison, items: comparison.items.map(item => ({ ...item, contextKeys: { ...item.contextKeys, 'sessions.changesCanReview': true } })) };
			} else {
				const changes = await raceCancellationError(this.chat.listTurnChanges(session.sessionId, threadId), controller.signal);
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				const candidates = selected?.id ? changes.filter(change => change.changeSetId === selected.id) : changes;
				if (!candidates.some(change => change.captureState !== 'discarded' && change.statistics.files > 0)) {
					this.showEmptyComparison(input.resource);
					return;
				}
				if (selected?.id) { await raceCancellationError(this.changesService.resolveChangeset(new SessionChangesEditorInput(input.resource).sessionResource, selected.id), controller.signal); }
				if (this.isDisposed || revision !== this.revision || controller.signal.aborted) { return; }
				comparison = await createTurnMultiDiffEditorInput(this.chat, { session, threadId }, 'throughCurrentTurn', selected?.id ? [selected.id] : undefined, controller.signal);
			}
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			if (!comparison.items.length) {
				this.showEmptyComparison(input.resource);
				return;
			}
			if (background && this.comparisonInput && this.comparison?.updateInput(comparison)) {
				this.comparisonInput = comparison;
				this.changesService.setChangesCount(input.resource, comparison.items.length);
				return;
			}
			if (!this.comparison) {
				this.comparison = this._register(this.instantiation.createInstance(MultiDiffEditor, { activeEditorId: this.id }));
				this.comparison.create(this.domNode);
				this.comparison.setVisible(false);
			}
			const pane = this.comparison;
			pane.setFileListAvailable(!!this.options.showFileList);
			this.layout(this.dimension);
			await raceCancellationError(pane.setInput(comparison, controller.signal), controller.signal);
			if (this.isDisposed || revision !== this.revision || controller.signal.aborted) {
				return;
			}
			this.comparisonInput = comparison;
			this.messageDomNode.hidden = true;
			this.changesService.setChangesCount(input.resource, comparison.items.length);
			// A new conversation starts at the header; cancel deferred first-change
			// navigation just as restoring an existing conversation's state does.
			this.restoreViewState(this.viewState ?? { scrollTop: 0, collapsedItemIds: [], itemViewStates: [] });
			pane.setVisible(true);
		} catch (error) {
			if (!this.isDisposed && revision === this.revision && !controller.signal.aborted) {
				const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
				// A failed capture cannot keep the previous comparison available for review.
				this.clearComparison();
				this.changesService.setChangesCount(input.resource, undefined);
				this.messageDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', String(error));
				this.messageDomNode.hidden = false;
				if (hadFocus) { this.domNode.focus(); }
			}
		} finally {
			// The caller's open operation ends here; an open comparison owns its lazy models.
			abortListener?.dispose();
			if (!this.isDisposed && revision === this.revision) {
				this.domNode.setAttribute('aria-busy', 'false');
				this.layout(this.dimension);
				// Session worktrees may have no renderer-visible file events. Recheck only while this scope is visible.
				if (this.uncommittedWatch.value && !this.uncommittedRefresh.isScheduled()) this.uncommittedRefresh.schedule();
			}
		}
	}
}
