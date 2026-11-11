import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/changesView.css';
import './media/changesViewActions.css';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { MultiDiffEditorFileList, type IMultiDiffEditorFileListItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorFileList.js';
import { ChangesStatsWidget } from '../../../../workbench/browser/changesStatsWidget.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatService, createThreadChangeFileResource, type ThreadChangesSummary, type TurnChangeSetSummary } from '../../../../workbench/services/chat/common/chatService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { createMultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { autorun, derived, observableValue } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISessionGitActionsService } from '../../../services/sessions/browser/sessionGitActionsService.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ChangesViewMode, type IChangesThreadFileItem } from '../common/changes.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';
import { SessionChangesStatsCache } from '../../../services/sessions/common/sessionChangesStatsCache.js';
import { createSessionFileChange, matchesSessionFileChange, type IActiveSessionThread, type ISessionFileChange } from '../../../services/sessions/common/session.js';
import { IWorkspaceFolderLabelService } from '../../../services/workspaceFolderLabel/browser/workspaceFolderLabelService.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';

interface IChangesTurnFileItem extends ISessionFileChange {
	readonly type: 'file';
	readonly id: string;
	readonly turnNumber: number;
}

type IChangesFileItem = IChangesTurnFileItem | IChangesThreadFileItem;

type ChangesListFile = IChangesFileItem & IMultiDiffEditorFileListItem;

/** Reviews the current checkpoint or a selected Turn capture for the Code conversation. */
export class ChangesViewPane extends ViewPane {
	private readonly files: MultiDiffEditorFileList<ChangesListFile>;
	private get tree() { return this.files.tree; }
	private readonly summary: HTMLParagraphElement;
	private readonly statusDomNode: HTMLParagraphElement;
	private readonly review: Button;
	private readonly preview: Button;
	private readonly retry: Button;
	private readonly statsCache: SessionChangesStatsCache;
	private readonly statistics = observableValue<TurnChangeSetSummary['statistics'] | undefined>(this, undefined);
	private rows: readonly IChangesFileItem[] = [];
	private threadRows: readonly IChangesThreadFileItem[] = [];
	private threadSummary: ThreadChangesSummary | undefined;
	private readonly changesetPicker: HTMLSelectElement;
	private readonly workingTree: HTMLOptionElement;
	private readonly modePicker: HTMLSelectElement;
	private readonly markReviewed: Button;
	private readonly markUnread: Button;
	private viewMode = ChangesViewMode.List;
	private stateResource: URI | undefined;
	private request = 0;
	private owner: string | undefined;
	private loading = false;
	private readonly loadingProgress = this._register(new MutableDisposable());
	private readonly worktreeLabelRequest = this._register(new MutableDisposable());
	private readonly worktreeReview = this._register(new MutableDisposable());
	private readonly commitPreview = this._register(new MutableDisposable());
	// Returning to the same conversation must not revive work started before hiding or switching.
	private ownerEpoch = 0;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ISessionsService private readonly sessions: ISessionsService,
		@IChatService private readonly chat: IChatService,
		@IEditorService private readonly editors: IEditorService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IInstantiationService instantiation: IInstantiationService,
		@IChangesViewService private readonly viewState: IChangesViewService,
		@ISessionChangesService private readonly changesService: ISessionChangesService,
		@IStorageService storage: IStorageService,
		@IWorkspaceFolderLabelService private readonly folderLabels: IWorkspaceFolderLabelService,
		@ISessionGitActionsService private readonly git: ISessionGitActionsService,
	) {
		super(container, options);
		this.statsCache = new SessionChangesStatsCache(storage);
		this.contentElement.classList.add('ash-sessions-changes');
		this.statusDomNode = h(container.ownerDocument, 'p');
		this.statusDomNode.setAttribute('role', 'status');
		this.contentElement.append(this.statusDomNode);
		const actions = h(container.ownerDocument, 'div', { className: 'ash-sessions-changes-primary-actions' });
		this.contentElement.append(actions);
		this.review = this._register(new Button(actions, {
			...defaultButtonStyles,
			size: 'small',
			label: localize('sessions.changes.review', 'Review all changes'),
			onClick: () => {
				const epoch = this.ownerEpoch;
				void this.openReview().catch(error => this.reportOperationError(error, epoch));
			},
		}));
		this.preview = this._register(new Button(actions, {
			...defaultButtonStyles,
			size: 'small',
			label: localize('sessions.changes.previewSelected', 'Preview selected changes'),
			onClick: () => {
				const epoch = this.ownerEpoch;
				void this.previewSelection().catch(error => this.reportOperationError(error, epoch));
			},
		}));
		this.preview.enabled = false;
		this.review.enabled = false;
		this.retry = this._register(new Button(actions, {
			...defaultButtonStyles,
			size: 'small',
			label: localize('sessions.changes.retry', 'Retry loading changes'),
			onClick: () => { void this.refresh(); },
		}));
		this.retry.hidden = true;
		this.summary = h(container.ownerDocument, 'p', { className: 'ash-sessions-changes-summary' });
		this.contentElement.append(this.summary);
		this._register(autorun(reader => { this.summary.hidden = !this.statistics.read(reader); }));
		this._register(instantiation.createInstance(ChangesStatsWidget, this.summary, derived(reader => {
			const statistics = this.statistics.read(reader);
			return statistics && { files: statistics.files, insertions: statistics.additions, deletions: statistics.deletions };
		}), true));
		const controls = h(container.ownerDocument, 'div', { className: 'ash-sessions-changes-view-actions' });
		this.contentElement.append(controls);
		this.changesetPicker = h(container.ownerDocument, 'select');
		this.changesetPicker.setAttribute('aria-label', localize('sessions.changes.chooseTurn', 'Changes from Turn'));
		this.workingTree = h(container.ownerDocument, 'option');
		this.workingTree.textContent = localize('sessions.changes.workingTree', 'Review working tree');
		const updateWorkingTree = () => {
			this.workingTree.hidden = !git.canReviewWorkingTree;
			this.workingTree.disabled = this.workingTree.hidden || git.busy;
		};
		this._register(git.onDidChange(updateWorkingTree));
		updateWorkingTree();
		this.modePicker = h(container.ownerDocument, 'select');
		this.modePicker.setAttribute('aria-label', localize('sessions.changes.viewMode', 'Changes view mode'));
		for (const [value, text] of [
			[ChangesViewMode.List, localize('sessions.changes.listMode', 'List')],
			[ChangesViewMode.Tree, localize('sessions.changes.treeMode', 'Tree')],
		] as const) {
			const option = h(container.ownerDocument, 'option');
			option.value = value;
			option.textContent = text;
			this.modePicker.append(option);
		}
		controls.append(this.changesetPicker, this.modePicker);
		this.markReviewed = this._register(new Button(controls, {
			...defaultButtonStyles,
			size: 'small',
			label: localize('sessions.changes.markReviewed', 'Mark reviewed'),
			onClick: () => this.setReviewState(true),
		}));
		this.markUnread = this._register(new Button(controls, {
			...defaultButtonStyles,
			size: 'small',
			label: localize('sessions.changes.markUnread', 'Mark unreviewed'),
			onClick: () => this.setReviewState(false),
		}));
		this._register(addDisposableListener(this.changesetPicker, 'change', () => {
			if (this.changesetPicker.selectedOptions[0] === this.workingTree) {
				// The working-tree diff opens separately and does not change the conversation filter.
				this.changesetPicker.value = this.changesetId ?? '';
				if (this.workingTree.disabled) { return; }
				const controller = new AbortController();
				const review = this.worktreeReview.value = toDisposable(() => controller.abort());
				void this.git.run('git.openChangesSource', controller.signal).finally(() => {
					if (this.worktreeReview.value === review) { this.worktreeReview.clear(); }
				});
				return;
			}
			this.saveTreeState();
			this.changesetId = this.changesetPicker.value || undefined;
			this.renderRows();
		}));
		this._register(addDisposableListener(this.modePicker, 'change', () => {
			this.viewState.setViewMode(this.modePicker.value === ChangesViewMode.Tree ? ChangesViewMode.Tree : ChangesViewMode.List);
		}));
		const treeContainer = h(container.ownerDocument, 'div');
		treeContainer.className = 'ash-sessions-changes-tree';
		this.contentElement.append(treeContainer);
		this.trackBodyMinimum(treeContainer, this.minimumBodySize);
		this.files = this._register(instantiation.createInstance(MultiDiffEditorFileList<ChangesListFile>, treeContainer, {
			openOnSingleClick: false,
			ariaLabel: localize('sessions.changes.title', 'Changes'),
			group: (row: ChangesListFile) => 'summary' in row
				? { id: `turn:${row.summary.changeSetId}`, label: localize('sessions.changes.turn', 'Turn {0}', row.turnNumber) }
				: { id: `repository:${row.repositoryId}`, label: row.repositoryLabel ?? localize('sessions.changes.conversationChanges', 'Conversation Changes') },
			renderDetails: (element: HTMLElement, row: ChangesListFile) => this.renderFileDetails(element, row),
		}));
		this._register(autorun(reader => {
			const mode = viewState.viewModeObs.read(reader);
			if (mode !== this.viewMode) {
				this.saveTreeState();
				this.viewMode = mode;
				this.renderRows();
			}
			this.modePicker.value = mode;
		}));
		this._register(viewState.reviewedFilesObs.onDidChange(() => {
			this.tree.rerender();
			this.updatePreviewSelection();
		}));
		this._register(autorun(reader => {
			const id = viewState.getChangesetId(this.stateResource, reader);
			if (!this.loading && this.rows.length && this.changesetPicker.value !== (id ?? '')) {
				this.changesetPicker.value = id ?? '';
				this.renderRows();
			}
		}));
		this._register(this.tree.onDidChangeSelection(event => {
			this.updatePreviewSelection();
			if (event.browserEvent) { this.saveTreeState(); }
		}));
		this._register(this.tree.onDidChangeFocus(event => { if (event.browserEvent) { this.saveTreeState(); } }));
		this._register(this.tree.onDidChangeCollapseState(event => { if (event.browserEvent) { this.saveTreeState(); } }));
		const scoped = this._register(contextKeys.createScoped(this.contentElement));
		scoped.createKey('sessionsChangesFocused', true);
		const updateHint = (): void => {
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsChanges);
			if (hint) { this.tree.domNode.setAttribute('aria-description', hint); }
			else { this.tree.domNode.removeAttribute('aria-description'); }
		};
		this._register(configuration.onDidChangeConfiguration(updateHint));
		updateHint();
		this._register(this.tree.onDidOpen(event => {
			const epoch = this.ownerEpoch;
			const request = this.request;
			if (event.element.type === 'file') {
				const resource = event.element.uri;
				void this.openFile(event.element, event.editorOptions, event.sideBySide).catch(error => {
					if (request === this.request && this.visibleRows().some(row => matchesSessionFileChange(row, resource))) { this.reportOperationError(error, epoch); }
				});
			}
		}));
		this._register(sessions.onDidChange(() => { void this.refresh(); }));
		this._register(chat.onDidUpdateTurnChanges(event => {
			const active = sessions.activeSelection;
			if (active?.kind === 'session' && active.active.session.sessionId === event.sessionId && active.active.threadId === event.threadId) { void this.refresh(); }
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
		this._register(chat.onDidUpdateThread(event => {
			if (event.update.type !== 'committed' || event.update.event.type !== 'threadHistoryMoved') { return; }
			const active = sessions.activeSelection;
			if (active?.kind === 'session' && active.active.session.sessionId === event.sessionId && active.active.threadId === event.threadId) { void this.refresh(); }
		}));
		this._register(addDisposableListener(this.tree.domNode, 'focus', updateHint));
		this._register(storage.onWillSaveState(() => this.saveTreeState()));
	}

	public override setVisible(visible: boolean): void {
		if (visible === this.isVisible()) { return; }
		super.setVisible(visible);
		if (visible) {
			void this.refresh();
		} else {
			this.saveTreeState();
			this.loadingProgress.clear();
			this.worktreeLabelRequest.clear();
			this.worktreeReview.clear();
			this.commitPreview.clear();
			this.request++;
			this.ownerEpoch++;
		}
	}

	public focus(): void { this.tree.domFocus(); }

	public override dispose(): void {
		if (this.isDisposed) { return; }
		this.saveTreeState();
		this.request++;
		this.ownerEpoch++;
		super.dispose();
	}

	private reportOperationError(error: unknown, epoch: number): void {
		if (!this.isDisposed && this.isVisible() && epoch === this.ownerEpoch) { this.notifications.error(getErrorMessage(error)); }
	}

	public getAccessibleContent(): string {
		const selected = new Set(this.tree.selection.map(row => row.id));
		const files = this.visibleRows().map(row => [
			`${row.file.path}: +${row.file.additions} −${row.file.deletions}`,
			'summary' in row ? localize('sessions.changes.turn', 'Turn {0}', row.turnNumber) : row.repositoryLabel,
			fileState(row),
			this.viewState.reviewedFilesObs.get().has(row.uri.toString()) ? localize('sessions.changes.reviewed', 'Reviewed') : undefined,
			selected.has(row.id) ? localize('sessions.changes.fileSelected', 'Selected') : undefined,
			...('summary' in row ? [row.summary.failureMessage, ...row.summary.warnings] : row.warnings),
		].filter(Boolean).join('; '));
		return [
			localize('sessions.changes.title', 'Changes'),
			this.statusDomNode.textContent,
			this.summary.textContent,
			...files,
		].join('\n');
	}

	private renderFileDetails(element: HTMLElement, row: IChangesFileItem): void {
		const state = h(element.ownerDocument, 'span', { className: 'ash-sessions-change-state' });
		state.textContent = [
			'summary' in row ? localize('sessions.changes.turn', 'Turn {0}', row.turnNumber) : row.repositoryLabel,
			fileState(row),
			this.viewState.reviewedFilesObs.get().has(row.uri.toString()) ? localize('sessions.changes.reviewed', 'Reviewed') : undefined,
		].filter(Boolean).join(' · ');
		state.title = [state.textContent, ...('summary' in row ? [row.summary.failureMessage, ...row.summary.warnings] : row.warnings)].filter(Boolean).join('\n');
		const counts = h(element.ownerDocument, 'span');
		counts.textContent = `+${row.insertions} −${row.deletions}`;
		element.append(state, counts);
	}

	private updatePreviewSelection(): void {
		const selected = this.tree.selection.filter(row => row.type === 'file');
		const onlyFiles = selected.length > 0 && selected.length === this.tree.selection.length;
		this.preview.enabled = !this.loading && onlyFiles && selected.every(row => 'summary' in row && row.summary.captureState === 'sealed' && !row.summary.committedPaths.includes(row.file.path) && row.summary.commitState !== 'queued' && row.summary.commitState !== 'committing' && 'summary' in selected[0]! && row.summary.repositoryId === selected[0].summary.repositoryId);
		this.markReviewed.enabled = !this.loading && onlyFiles;
		this.markUnread.enabled = !this.loading && onlyFiles;
	}

	private visibleRows(): readonly IChangesFileItem[] {
		return this.changesetId ? this.rows.filter(row => 'summary' in row && row.summary.changeSetId === this.changesetId) : this.threadRows;
	}

	private get changesetId(): string | undefined {
		return this.stateResource ? this.viewState.getChangesetId(this.stateResource) : undefined;
	}

	private set changesetId(id: string | undefined) {
		if (!this.stateResource) { return; }
		this.viewState.setChangesetId(id, this.stateResource);
	}

	private setReviewState(reviewed: boolean): void {
		if (!this.isVisible() || this.loading) { return; }
		this.viewState.setChangesetFilesReviewState(this.tree.selection.filter(row => row.type === 'file').map(row => row.uri), reviewed);
	}

	private saveTreeState(): void {
		if (!this.stateResource || !this.visibleRows().length) { return; }
		const expanded: Record<string, 0 | 1> = {};
		for (const item of this.tree.getVisibleElements()) {
			if (item.type === 'folder') { expanded[item.id] = this.tree.isCollapsed(item.id) ? 0 : 1; }
		}
		this.viewState.setDetailsViewState(this.stateResource.with({ fragment: this.changesetId ?? '' }), this.viewMode, {
			focus: this.tree.focus ? [this.tree.focus.id] : [],
			selection: this.tree.selection.map(row => row.id), expanded, scrollTop: this.tree.scrollTop,
		});
	}

	private renderRows(): void {
		const rows = this.visibleRows();
		this.files.setFiles(rows.map(row => ({
			...row, path: row.file.path, resource: row.modifiedUri,
			label: row.file.previousPath ? `${row.file.previousPath} → ${row.file.path}` : undefined,
		})), this.viewMode);
		for (const row of this.tree.getVisibleElements()) {
			if (row.type === 'folder') { this.tree.expandRecursive(row.id); }
		}
		const state = this.stateResource && this.viewState.getDetailsViewState(this.stateResource.with({ fragment: this.changesetId ?? '' }), this.viewMode);
		if (state) {
			for (const [id, expanded] of Object.entries(state.expanded)) {
				if (!expanded && this.tree.isCollapsed(id) !== undefined) { this.tree.collapse(id); }
			}
			this.tree.setSelection(state.selection);
			if (state.focus[0]) { this.tree.setFocus(state.focus[0]); }
			this.tree.scrollTop = state.scrollTop;
		} else {
			this.tree.setSelection([]);
			this.tree.scrollTop = 0;
		}
		this.review.enabled = !this.loading && rows.length > 0;
		this.updatePreviewSelection();
		this.statistics.set(!this.changesetId ? this.threadSummary?.statistics : rows.length ? {
			files: rows.length, additions: rows.reduce((sum, row) => sum + row.file.additions, 0),
			deletions: rows.reduce((sum, row) => sum + row.file.deletions, 0),
		} : undefined);
		if (!this.loading) {
			const message = rows.length ? localize('sessions.changes.count', '{0} changed files', rows.length) : localize('sessions.changes.empty', 'No changes in this conversation.');
			this.statusDomNode.textContent = [message, ...(!this.changesetId ? this.threadSummary?.warnings ?? [] : [])].join('\n');
		}
	}

	private async refresh(): Promise<void> {
		if (!this.isVisible() || this.isDisposed) { return; }
		const request = ++this.request;
		this.worktreeLabelRequest.clear();
		this.statusDomNode.hidden = false;
		this.loadingProgress.clear();
		this.loading = true;
		this.saveTreeState();
		this.changesetPicker.disabled = true;
		this.updatePreviewSelection();
		this.review.enabled = false;
		this.preview.enabled = false;
		this.retry.hidden = true;
		this.tree.domNode.setAttribute('aria-busy', 'true');
		const selection = this.sessions.activeSelection;
		const resource = selection ? new SessionChangesEditorInput(selection).resource : undefined;
		const owner = selection?.kind === 'session' ? resource!.toString() : undefined;
		const ownerChanged = owner !== this.owner;
		if (ownerChanged) {
			this.ownerEpoch++;
			this.commitPreview.clear();
		}
		this.owner = owner;
		this.stateResource = resource;
		if (ownerChanged || !owner) {
			this.changesetPicker.replaceChildren();
			this.rows = [];
			this.threadRows = [];
			this.threadSummary = undefined;
			this.files.setFiles([], this.viewMode);
			this.review.enabled = false;
			this.preview.enabled = false;
			this.statistics.set(owner && !this.changesetId ? this.statsCache.get(owner) : undefined, undefined);
		}
		if (selection?.kind !== 'session') {
			this.loading = false;
			this.changesetPicker.disabled = false;
			this.tree.domNode.removeAttribute('aria-busy');
			this.statusDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			return;
		}
		this.statusDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
		this.statusDomNode.hidden = false;
		const progress = this.getProgressIndicator().show(true, 150);
		this.loadingProgress.value = toDisposable(() => progress.done());
		try {
			const active = selection.active;
			const [summaries, summary] = await Promise.all([
				this.chat.listTurnChanges(active.session.sessionId, active.threadId),
				this.chat.readThreadChanges(active.session.sessionId, active.threadId),
			]);
			if (this.isDisposed || request !== this.request) { return; }
			const details = await Promise.all(summaries.filter(summary => summary.captureState !== 'discarded').map(summary => this.chat.readTurnChange(active.session.sessionId, active.threadId, summary.changeSetId)));
			if (this.isDisposed || request !== this.request) { return; }
			this.loading = false;
			this.threadSummary = summary;
			this.statsCache.set(owner!, summary.statistics);
			this.threadRows = summary.repositories.flatMap((repository, index) => repository.files.map(file => {
				const uri = createThreadChangeFileResource(active.session.sessionId, active.threadId, summary.revision, repository.repositoryId, file.path);
				return {
					type: 'file' as const, id: JSON.stringify([repository.repositoryId, file.path]),
					sessionId: active.session.sessionId, threadId: active.threadId, repositoryId: repository.repositoryId, revision: summary.revision,
					repositoryLabel: summary.repositories.length > 1 ? localize('sessions.changes.repository', 'Repository {0}', index + 1) : undefined,
					uri, originalUri: uri.with({ query: `${uri.query}&side=before` }), modifiedUri: uri.with({ query: `${uri.query}&side=after` }),
					file, insertions: file.additions, deletions: file.deletions, warnings: summary.warnings,
				};
			}));
			this.rows = details.flatMap((details, index) => details.files.map(file => ({
				type: 'file' as const, id: `${details.summary.changeSetId}:${file.path}`,
				...createSessionFileChange(details.summary, file), turnNumber: index + 1,
			})));
			const selectedTurn = this.changesetId;
			this.changesetPicker.replaceChildren();
			const all = h(this.contentElement.ownerDocument, 'option');
			all.value = '';
			all.textContent = localize('sessions.changes.conversationChanges', 'Conversation Changes');
			this.changesetPicker.append(all);
			for (const [index, entry] of details.entries()) {
				const option = h(this.contentElement.ownerDocument, 'option');
				option.value = entry.summary.changeSetId;
				option.textContent = localize('sessions.changes.turn', 'Turn {0}', index + 1);
				this.changesetPicker.append(option);
			}
			this.changesetPicker.append(this.workingTree);
			// Only an authoritative successful catalogue can clear a missing preference.
			this.changesetId = details.some(entry => entry.summary.changeSetId === selectedTurn) ? selectedTurn : undefined;
			this.changesetPicker.value = this.changesetId ?? '';
			this.renderRows();
			if (summary.repositories.length === 1 && this.threadRows.length) {
				void this.updateWorktreeLabel(active, request).catch(error => {
					if (request === this.request) this.reportOperationError(error, this.ownerEpoch);
				});
			}
		} catch (error) {
			if (this.isDisposed || request !== this.request) { return; }
			this.rows = [];
			this.threadRows = [];
			this.threadSummary = undefined;
			this.files.setFiles([], this.viewMode);
			this.statistics.set(owner && !this.changesetId ? this.statsCache.get(owner) : undefined, undefined);
			this.retry.hidden = false;
			this.statusDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', error instanceof Error ? error.message : String(error));
		} finally {
			if (!this.isDisposed && request === this.request) {
				this.loadingProgress.clear();
				this.loading = false;
				this.statusDomNode.hidden = false;
				this.changesetPicker.disabled = !this.retry.hidden;
				this.updatePreviewSelection();
				this.tree.domNode.removeAttribute('aria-busy');
			}
		}
	}

	private async updateWorktreeLabel(active: IActiveSessionThread, request: number): Promise<void> {
		using cancellation = new CancellationTokenSource();
		const lifetime = this.worktreeLabelRequest.value = toDisposable(() => cancellation.cancel());
		try {
			const label = await this.folderLabels.readWorktreeLabel(active, cancellation.token);
			if (!label || cancellation.token.isCancellationRequested || request !== this.request) return;
			this.threadRows = this.threadRows.map(row => ({ ...row, repositoryLabel: label }));
			if (!this.changesetId) {
				this.saveTreeState();
				this.renderRows();
			}
		} finally {
			if (this.worktreeLabelRequest.value === lifetime) this.worktreeLabelRequest.clear();
		}
	}

	private async openReview(): Promise<void> {
		const selection = this.sessions.activeSelection;
		if (!this.isVisible() || selection?.kind !== 'session') { return; }
		await this.changesService.openChangesEditor(new SessionChangesEditorInput(selection).sessionResource, {
			changesetSelection: { kind: 'id', id: this.changesetId },
		});
	}

	private async previewSelection(): Promise<void> {
		const selection = this.sessions.activeSelection;
		if (!this.isVisible() || selection?.kind !== 'session') { return; }
		const selected = this.tree.selection.filter(row => row.type === 'file' && 'summary' in row);
		if (!selected.length) return;
		const cancellation = new CancellationTokenSource();
		const request = toDisposable(() => cancellation.dispose(true));
		this.commitPreview.value = request;
		try {
			await this.changesService.previewSelectedFiles(new SessionChangesEditorInput(selection).sessionResource, cancellation.token, selected);
		} catch (error) {
			if (!cancellation.token.isCancellationRequested) throw error;
		} finally {
			if (this.commitPreview.value === request) this.commitPreview.clear();
		}
	}

	private async openFile(row: IChangesFileItem, options: IEditorOptions, sideBySide: boolean): Promise<void> {
		if (!this.isVisible() || this.loading) { return; }
		const ownerEpoch = this.ownerEpoch;
		const resource = row.uri;
		const contents = 'summary' in row
			? await this.chat.readTurnChangeFile(row.summary.sessionId, row.summary.threadId, row.summary.changeSetId, row.file.path)
			: await this.chat.readThreadChangeFile(row.sessionId, row.threadId, row.revision, row.repositoryId, row.file.path);
		// A refresh can replace a capture without changing the selected conversation.
		if (this.isDisposed || ownerEpoch !== this.ownerEpoch || this.loading || !this.visibleRows().some(row => matchesSessionFileChange(row, resource))) { return; }
		if (contents.truncated && !contents.binary) { throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.')); }
		const current = 'summary' in row
			? await this.chat.readTurnChange(row.summary.sessionId, row.summary.threadId, row.summary.changeSetId)
			: await this.chat.readThreadChanges(row.sessionId, row.threadId);
		if (this.isDisposed || ownerEpoch !== this.ownerEpoch || this.loading || !this.visibleRows().some(row => matchesSessionFileChange(row, resource))) { return; }
		if ('summary' in row ? !('summary' in current) || current.summary.revision !== row.summary.revision || current.summary.captureState === 'discarded' : !('revision' in current) || current.revision !== row.revision) {
			throw new Error(localize('sessions.changes.captureChanged', 'This Turn capture changed while loading. Reopen its changes to review the latest revision.'));
		}
		const before = resource.with({ query: `${resource.query}&side=before` });
		const after = resource.with({ query: `${resource.query}&side=after` });
		if (contents.binary) {
			await this.editors.openEditor(createMultiDiffEditorInput(resource.with({ scheme: 'ash-multi-diff' }), [{
				label: row.file.path, binary: true,
				original: { resource: before, readOnly: true },
				modified: { resource: after, readOnly: true },
			}], row.file.path), options, sideBySide ? 'sideGroup' : 'activeGroup');
			return;
		}
		await this.editors.openEditor(createDiffEditorInput(
			{ resource: before, initialText: contents.before ?? '', readOnly: true },
			{ resource: after, initialText: contents.after ?? '', readOnly: true },
			row.file.path,
		), options, sideBySide ? 'sideGroup' : 'activeGroup');
	}
}

function fileState(row: IChangesFileItem): string {
	if (!('summary' in row)) { return ''; }
	const summary = row.summary;
	if (summary.committedPaths.includes(row.file.path)) { return localize('sessions.changes.fileCommitted', 'Committed'); }
	if (summary.captureState !== 'sealed') { return localize('sessions.changes.fileUnsealed', 'Not sealed'); }
	switch (summary.commitState) {
		case 'queued': return localize('sessions.changes.fileQueued', 'Queued');
		case 'committing': return localize('sessions.changes.fileCommitting', 'Committing');
		case 'conflict': return localize('sessions.changes.fileConflict', 'Conflict — preview again after resolving');
		case 'failed': return localize('sessions.changes.fileFailed', 'Commit failed: {0}', summary.failureMessage ?? '');
		case 'idle': case 'partiallyCommitted': case 'committed': return localize('sessions.changes.fileRemaining', 'Not committed');
	}
}
