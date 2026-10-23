import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/changesView.css';
import './media/changesViewActions.css';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatService, type TurnChangeSetSummary, type TurnCommitSelection } from '../../../../workbench/services/chat/common/chatService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { createMultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { createTurnCommitPreviewInput } from '../../../browser/turnMultiDiffSource.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ChangesSummaryWidget } from './changesSummaryWidget.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ChecksWidget } from './checksWidget.js';
import { SessionSyncChangesActionViewItem } from './sessionSyncChanges.js';
import { CreatePullRequestContextView } from './createPullRequestContextView.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ChangesViewMode } from '../common/changes.js';
import {
	buildTreeChildren, ChangesTreeRenderer, fileState,
	isChangesFileItem, type ChangesTreeElement, type IChangesFileItem,
} from './changesViewRenderer.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';
import { autorun } from '../../../../base/common/observable.js';
import { findChangesEditorFileChange, getChangesEditorFileResource } from './changesEditorLabels.js';
import { createSessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';

/** Reviews immutable Turn changes for the selected Code conversation. */
export class ChangesViewPane extends ViewPane {
	private readonly tree: WorkbenchObjectTree<ChangesTreeElement>;
	private readonly statusDomNode: HTMLParagraphElement;
	private readonly review: Button;
	private readonly preview: Button;
	private readonly retry: Button;
	private readonly statistics = observableValue<TurnChangeSetSummary['statistics'] | undefined>(this, undefined);
	private rows: readonly IChangesFileItem[] = [];
	private readonly changesetPicker: HTMLSelectElement;
	private readonly modePicker: HTMLSelectElement;
	private readonly markReviewed: Button;
	private readonly markUnread: Button;
	private viewMode = ChangesViewMode.List;
	private stateResource: URI | undefined;
	private request = 0;
	private owner: string | undefined;
	private loading = false;
	private readonly loadingProgress = this._register(new MutableDisposable());
	private readonly checks = this._register(new MutableDisposable<ChecksWidget>());
	private readonly gitActions = this._register(new MutableDisposable<SessionSyncChangesActionViewItem>());
	private readonly pullRequest = this._register(new MutableDisposable<CreatePullRequestContextView>());
	private readonly createPullRequest: Button;
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
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IChangesViewService private readonly viewState: IChangesViewService,
		@ISessionChangesService private readonly changesService: ISessionChangesService,
		@IStorageService storage: IStorageService,
	) {
		super(container, options);
		this.contentElement.classList.add('ash-sessions-changes');
		this.statusDomNode = h(container.ownerDocument, 'p');
		this.statusDomNode.setAttribute('role', 'status');
		this.contentElement.append(this.statusDomNode);
		this.review = this._register(new Button(this.contentElement, {
			...defaultButtonStyles,
			label: localize('sessions.changes.review', 'Review all changes'),
			onClick: () => {
				const epoch = this.ownerEpoch;
				void this.openReview().catch(error => this.reportOperationError(error, epoch));
			},
		}));
		this.preview = this._register(new Button(this.contentElement, {
			...defaultButtonStyles,
			label: localize('sessions.changes.previewSelected', 'Preview selected changes'),
			onClick: () => {
				const epoch = this.ownerEpoch;
				void this.previewSelection().catch(error => this.reportOperationError(error, epoch));
			},
		}));
		this.preview.enabled = false;
		this.review.enabled = false;
		this.retry = this._register(new Button(this.contentElement, {
			...defaultButtonStyles,
			label: localize('sessions.changes.retry', 'Retry loading changes'),
			onClick: () => { void this.refresh(); },
		}));
		this.retry.domNode.hidden = true;
		this.createPullRequest = this._register(new Button(this.contentElement, {
			...defaultButtonStyles,
			label: localize('sessions.changes.createPR', 'Create pull request'),
			onClick: () => {
				const view = this.instantiation.createInstance(CreatePullRequestContextView);
				this.pullRequest.value = view;
				void view.show(this.createPullRequest.domNode).catch(error => { if (!view.isDisposed) { this.notifications.error(getErrorMessage(error)); view.dispose(); } });
			},
		}));
		const updatePullRequest = (): void => {
			const selected = this.sessions.activeSelection;
			this.createPullRequest.domNode.hidden = selected?.kind !== 'session' || !selected.active.session.workspace;
		};
		this._register(sessions.onDidChange(updatePullRequest));
		updatePullRequest();
		this._register(instantiation.createInstance(ChangesSummaryWidget, this.statistics)).render(this.contentElement);
		const controls = h(container.ownerDocument, 'div', { className: 'ash-sessions-changes-view-actions' });
		this.contentElement.append(controls);
		this.changesetPicker = h(container.ownerDocument, 'select');
		this.changesetPicker.setAttribute('aria-label', localize('sessions.changes.chooseTurn', 'Changes from Turn'));
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
			label: localize('sessions.changes.markReviewed', 'Mark reviewed'),
			onClick: () => this.setReviewState(true),
		}));
		this.markUnread = this._register(new Button(controls, {
			...defaultButtonStyles,
			label: localize('sessions.changes.markUnread', 'Mark unreviewed'),
			onClick: () => this.setReviewState(false),
		}));
		this._register(addDisposableListener(this.changesetPicker, 'change', () => {
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
		const renderer = new ChangesTreeRenderer(container.ownerDocument);
		this.tree = this._register(new WorkbenchObjectTree<ChangesTreeElement>(treeContainer, {
			configurationService: configuration,
			multipleSelectionSupport: true,
			openOnSingleClick: false,
			ariaLabel: localize('sessions.changes.title', 'Changes'),
			modelOptions: { identityProvider: { getId: row => row.id }, defaultCollapseState: 'expanded' },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: row => isChangesFileItem(row) ? row.file.path : row.name },
			renderElement: row => renderer.renderElement(row,
				isChangesFileItem(row) && this.viewState.reviewedFilesObs.get().has(getChangesEditorFileResource(row).toString()),
				this.viewMode === ChangesViewMode.Tree),
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
			if (isChangesFileItem(event.element)) {
				const resource = getChangesEditorFileResource(event.element);
				void this.openFile(event.element, event.editorOptions, event.sideBySide).catch(error => {
					if (findChangesEditorFileChange(resource, this.rows)) { this.reportOperationError(error, epoch); }
				});
			}
		}));
		this._register(sessions.onDidChange(() => { void this.refresh(); }));
		this._register(chat.onDidUpdateTurnChanges(event => {
			const active = sessions.activeSelection;
			if (active?.kind === 'session' && active.active.session.sessionId === event.sessionId && active.active.threadId === event.threadId) { void this.refresh(); }
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
		this._register(addDisposableListener(this.tree.domNode, 'focus', updateHint));
		this._register(storage.onWillSaveState(() => this.saveTreeState()));
	}

	public override setVisible(visible: boolean): void {
		if (visible === this.isVisible()) { return; }
		super.setVisible(visible);
		if (visible) {
			this.gitActions.value = this.instantiation.createInstance(SessionSyncChangesActionViewItem, this.contentElement);
			this.checks.value = this.instantiation.createInstance(ChecksWidget, this.contentElement);
			void this.refresh();
		} else {
			this.saveTreeState();
			this.pullRequest.clear();
			this.gitActions.clear();
			this.checks.clear();
			this.loadingProgress.clear();
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
		const selected = new Set(this.tree.selection);
		const files = this.visibleRows().map(row => [
			`${row.file.path}: +${row.file.additions} −${row.file.deletions}`,
			localize('sessions.changes.turn', 'Turn {0}', row.turnNumber),
			fileState(row),
			this.viewState.reviewedFilesObs.get().has(getChangesEditorFileResource(row).toString()) ? localize('sessions.changes.reviewed', 'Reviewed') : undefined,
			selected.has(row) ? localize('sessions.changes.fileSelected', 'Selected') : undefined,
			row.summary.failureMessage,
			...row.summary.warnings,
		].filter(Boolean).join('; '));
		return [
			localize('sessions.changes.title', 'Changes'),
			this.statusDomNode.textContent,
			this.contentElement.querySelector('.ash-sessions-changes-summary')?.textContent,
			this.contentElement.querySelector('.ash-sessions-changes-repository-status')?.textContent,
			...files,
			this.checks.value?.element.textContent,
		].join('\n');
	}

	private updatePreviewSelection(): void {
		const selected = this.tree.selection.filter(isChangesFileItem);
		const onlyFiles = selected.length > 0 && selected.length === this.tree.selection.length;
		this.preview.enabled = !this.loading && onlyFiles && selected.every(row => row.summary.captureState === 'sealed' && !row.summary.committedPaths.includes(row.file.path) && row.summary.commitState !== 'queued' && row.summary.commitState !== 'committing' && row.summary.repositoryId === selected[0]!.summary.repositoryId);
		this.markReviewed.enabled = !this.loading && onlyFiles;
		this.markUnread.enabled = !this.loading && onlyFiles;
	}

	private visibleRows(): readonly IChangesFileItem[] {
		return this.changesetId ? this.rows.filter(row => row.summary.changeSetId === this.changesetId) : this.rows;
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
		this.viewState.setChangesetFilesReviewState(this.tree.selection.filter(isChangesFileItem).map(getChangesEditorFileResource), reviewed);
	}

	private saveTreeState(): void {
		if (!this.stateResource || !this.rows.length) { return; }
		const expanded: Record<string, 0 | 1> = {};
		for (const item of this.tree.getVisibleElements()) {
			if (!isChangesFileItem(item)) { expanded[item.id] = this.tree.isCollapsed(item.id) ? 0 : 1; }
		}
		this.viewState.setDetailsViewState(this.stateResource.with({ fragment: this.changesetId ?? '' }), this.viewMode, {
			focus: this.tree.focus ? [this.tree.focus.id] : [],
			selection: this.tree.selection.map(row => row.id), expanded, scrollTop: this.tree.scrollTop,
		});
	}

	private renderRows(): void {
		const rows = this.visibleRows();
		const children = this.viewMode === ChangesViewMode.Tree ? buildTreeChildren(rows) : rows.map(element => ({ element }));
		this.tree.setChildren(children);
		for (const child of children) {
			if (!isChangesFileItem(child.element)) { this.tree.expandRecursive(child.element.id); }
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
		this.statistics.set(rows.length ? {
			files: rows.length, additions: rows.reduce((sum, row) => sum + row.file.additions, 0),
			deletions: rows.reduce((sum, row) => sum + row.file.deletions, 0),
		} : undefined);
	}

	private async refresh(): Promise<void> {
		if (!this.isVisible() || this.isDisposed) { return; }
		const request = ++this.request;
		this.loadingProgress.clear();
		this.loading = true;
		this.saveTreeState();
		this.changesetPicker.disabled = true;
		this.updatePreviewSelection();
		this.review.enabled = false;
		this.preview.enabled = false;
		this.retry.domNode.hidden = true;
		this.tree.domNode.setAttribute('aria-busy', 'true');
		const selection = this.sessions.activeSelection;
		const resource = selection ? new SessionChangesEditorInput(selection).resource : undefined;
		const owner = selection?.kind === 'session' ? resource!.toString() : undefined;
		const ownerChanged = owner !== this.owner;
		if (ownerChanged) { this.ownerEpoch++; }
		this.owner = owner;
		this.stateResource = resource;
		if (ownerChanged || !owner) {
			this.changesetPicker.replaceChildren();
			this.rows = [];
			this.tree.setChildren([]);
			this.review.enabled = false;
			this.preview.enabled = false;
			this.statistics.set(undefined, undefined);
		}
		if (selection?.kind !== 'session') {
			this.loading = false;
			this.changesetPicker.disabled = false;
			this.tree.domNode.removeAttribute('aria-busy');
			this.statusDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			return;
		}
		this.statusDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
		const progress = this.getProgressIndicator().show(true, 150);
		this.loadingProgress.value = toDisposable(() => progress.done());
		try {
			const active = selection.active;
			const summaries = await this.chat.listTurnChanges(active.session.sessionId, active.threadId);
			if (this.isDisposed || request !== this.request) { return; }
			const details = await Promise.all(summaries.filter(summary => summary.captureState !== 'discarded').map(summary => this.chat.readTurnChange(active.session.sessionId, active.threadId, summary.changeSetId)));
			if (this.isDisposed || request !== this.request) { return; }
			this.loading = false;
			this.rows = details.flatMap((details, index) => details.files.map(file => ({
				type: 'file' as const, id: `${details.summary.changeSetId}:${file.path}`,
				...createSessionFileChange(details.summary, file), turnNumber: index + 1,
			})));
			const selectedTurn = this.changesetId;
			this.changesetPicker.replaceChildren();
			const all = h(this.contentElement.ownerDocument, 'option');
			all.value = '';
			all.textContent = localize('sessions.changes.allTurns', 'All Turns');
			this.changesetPicker.append(all);
			for (const [index, entry] of details.entries()) {
				const option = h(this.contentElement.ownerDocument, 'option');
				option.value = entry.summary.changeSetId;
				option.textContent = localize('sessions.changes.turn', 'Turn {0}', index + 1);
				this.changesetPicker.append(option);
			}
			// Only an authoritative successful catalogue can clear a missing preference.
			this.changesetId = details.some(entry => entry.summary.changeSetId === selectedTurn) ? selectedTurn : undefined;
			this.changesetPicker.value = this.changesetId ?? '';
			this.renderRows();
			this.statusDomNode.textContent = this.rows.length ? localize('sessions.changes.count', '{0} changed files', this.rows.length) : localize('sessions.changes.empty', 'No changes in this conversation.');
		} catch (error) {
			if (this.isDisposed || request !== this.request) { return; }
			this.rows = [];
			this.tree.setChildren([]);
			this.statistics.set(undefined, undefined);
			this.retry.domNode.hidden = false;
			this.statusDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', error instanceof Error ? error.message : String(error));
		} finally {
			if (!this.isDisposed && request === this.request) {
				this.loadingProgress.clear();
				this.loading = false;
				this.changesetPicker.disabled = !this.retry.domNode.hidden;
				this.updatePreviewSelection();
				this.tree.domNode.removeAttribute('aria-busy');
			}
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
		const ownerEpoch = this.ownerEpoch;
		const selected = this.tree.selection.filter(isChangesFileItem);
		const active = selection.active;
		const grouped = new Map<string, TurnCommitSelection>();
		for (const row of selected) {
			const existing = grouped.get(row.summary.changeSetId);
			grouped.set(row.summary.changeSetId, { changeSetId: row.summary.changeSetId, expectedRevision: row.summary.revision, paths: [...(existing?.paths ?? []), row.file.path] });
		}
		if (!grouped.size) { return; }
		const message = await this.quickInput.input({ title: localize('sessions.changes.commitMessage', 'Commit message'), validateInput: async value => value.trim() ? undefined : localize('sessions.changes.messageRequired', 'Enter a commit message.') });
		if (message === undefined || this.isDisposed || ownerEpoch !== this.ownerEpoch) { return; }
		const preview = await this.chat.prepareTurnCommit(active.session.sessionId, active.threadId, [...grouped.values()], message);
		if (this.isDisposed || ownerEpoch !== this.ownerEpoch) { return; }
		const input = await createTurnCommitPreviewInput(this.chat, active.session.sessionId, active.threadId, preview);
		if (this.isDisposed || ownerEpoch !== this.ownerEpoch) { return; }
		await this.editors.openEditor(input, { pinned: true });
	}

	private async openFile(row: IChangesFileItem, options: IEditorOptions, sideBySide: boolean): Promise<void> {
		if (!this.isVisible() || this.loading) { return; }
		const ownerEpoch = this.ownerEpoch;
		const summary = row.summary;
		const resource = getChangesEditorFileResource(row);
		const contents = await this.chat.readTurnChangeFile(summary.sessionId, summary.threadId, summary.changeSetId, row.file.path);
		// A refresh can replace a capture without changing the selected conversation.
		if (this.isDisposed || ownerEpoch !== this.ownerEpoch || this.loading || !findChangesEditorFileChange(resource, this.rows)) { return; }
		if (contents.truncated && !contents.binary) { throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.')); }
		const current = await this.chat.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId);
		if (this.isDisposed || ownerEpoch !== this.ownerEpoch || this.loading || !findChangesEditorFileChange(resource, this.rows)) { return; }
		if (current.summary.revision !== summary.revision || current.summary.captureState === 'discarded') {
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

