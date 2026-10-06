import './media/changesView.css';
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
import { IChatService, type TurnChangeFile, type TurnChangeSetSummary, type TurnCommitSelection } from '../../../../workbench/services/chat/common/chatService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { createTurnCommitPreviewInput, createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Button } from '../../../../base/browser/ui/button/button.js';

interface ChangeRow {
	readonly summary: TurnChangeSetSummary;
	readonly file: TurnChangeFile;
	readonly turnNumber: number;
}

/** Reviews immutable Turn changes for the selected Code conversation. */
export class ChangesViewPane extends ViewPane {
	private readonly tree: WorkbenchObjectTree<ChangeRow>;
	private readonly statusDomNode: HTMLParagraphElement;
	private readonly review: Button;
	private readonly preview: Button;
	private rows: readonly ChangeRow[] = [];
	private request = 0;
	private owner: string | undefined;

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
	) {
		super(container, options);
		this.contentElement.classList.add('ash-sessions-changes');
		this.statusDomNode = h(container.ownerDocument, 'p');
		this.statusDomNode.setAttribute('role', 'status');
		this.contentElement.append(this.statusDomNode);
		this.review = this._register(new Button(this.contentElement, {
			label: localize('sessions.changes.review', 'Review all changes'),
			onClick: () => { void this.openReview().catch(error => this.notifications.error(getErrorMessage(error))); },
		}));
		this.preview = this._register(new Button(this.contentElement, {
			label: localize('sessions.changes.previewSelected', 'Preview selected changes'),
			onClick: () => { void this.previewSelection().catch(error => this.notifications.error(getErrorMessage(error))); },
		}));
		this.preview.enabled = false;
		const treeContainer = h(container.ownerDocument, 'div');
		treeContainer.className = 'ash-sessions-changes-tree';
		this.contentElement.append(treeContainer);
		this.tree = this._register(new WorkbenchObjectTree(treeContainer, {
			configurationService: configuration,
			multipleSelectionSupport: true,
			openOnSingleClick: false,
			ariaLabel: localize('sessions.changes.title', 'Changes'),
			modelOptions: { identityProvider: { getId: row => `${row.summary.changeSetId}:${row.file.path}` } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: row => row.file.path },
			renderElement: row => {
				const element = h(container.ownerDocument, 'div');
				element.className = 'ash-sessions-change-row';
				const label = h(container.ownerDocument, 'span');
				label.className = 'ash-sessions-change-path';
				label.textContent = row.file.previousPath ? `${row.file.previousPath} → ${row.file.path}` : row.file.path;
				label.title = label.textContent;
				const counts = h(container.ownerDocument, 'span');
				counts.textContent = `+${row.file.additions} −${row.file.deletions}`;
				const state = h(container.ownerDocument, 'span');
				state.className = 'ash-sessions-change-state';
				state.textContent = `${localize('sessions.changes.turn', 'Turn {0}', row.turnNumber)} · ${fileState(row)}`;
				state.title = [row.summary.failureMessage, ...row.summary.warnings].filter(Boolean).join('\n');
				element.append(label, state, counts);
				return element;
			},
		}));
		this._register(this.tree.onDidChangeSelection(() => this.updatePreviewSelection()));
		const scoped = this._register(contextKeys.createScoped(this.tree.domNode));
		scoped.createKey('sessionsChangesFocused', true);
		const updateHint = (): void => {
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsChanges);
			if (hint) { this.tree.domNode.setAttribute('aria-description', hint); }
			else { this.tree.domNode.removeAttribute('aria-description'); }
		};
		this._register(configuration.onDidChangeConfiguration(updateHint));
		updateHint();
		this._register(this.tree.onDidOpen(event => { void this.openFile(event.element, event.editorOptions, event.sideBySide).catch(error => this.notifications.error(getErrorMessage(error))); }));
		this._register(sessions.onDidChange(() => { void this.refresh(); }));
		this._register(chat.onDidUpdateTurnChanges(event => {
			const active = sessions.activeSelection;
			if (active?.kind === 'session' && active.active.session.sessionId === event.sessionId && active.active.threadId === event.threadId) { void this.refresh(); }
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
		this._register(addDisposableListener(this.tree.domNode, 'focus', updateHint));
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) { void this.refresh(); }
	}

	public focus(): void { this.tree.domFocus(); }

	public getAccessibleContent(): string {
		return [localize('sessions.changes.title', 'Changes'), this.statusDomNode.textContent, ...this.rows.map(row => `${row.file.path}: +${row.file.additions} −${row.file.deletions}; ${localize('sessions.changes.turn', 'Turn {0}', row.turnNumber)}; ${fileState(row)}${this.tree.selection.includes(row) ? '; ' + localize('sessions.changes.fileSelected', 'Selected') : ''}${row.summary.failureMessage ? '; ' + row.summary.failureMessage : ''}${row.summary.warnings.length ? '; ' + row.summary.warnings.join('; ') : ''}`)].join('\n');
	}

	private updatePreviewSelection(): void {
		const selected = this.tree.selection;
		this.preview.enabled = selected.length > 0 && selected.every(row => row.summary.captureState === 'sealed' && !row.summary.committedPaths.includes(row.file.path) && row.summary.commitState !== 'queued' && row.summary.commitState !== 'committing' && row.summary.repositoryId === selected[0]!.summary.repositoryId);
	}

	private async refresh(): Promise<void> {
		const request = ++this.request;
		const selection = this.sessions.activeSelection;
		const owner = selection?.kind === 'session' ? `${selection.active.session.sessionId}:${selection.active.threadId}` : undefined;
		const selectedIds = owner === this.owner ? this.tree.selection.map(row => `${row.summary.changeSetId}:${row.file.path}`) : [];
		const focused = owner === this.owner ? this.tree.focus : undefined;
		this.owner = owner;
		if (!owner || !selectedIds.length) {
			this.rows = [];
			this.tree.setChildren([]);
			this.review.enabled = false;
			this.preview.enabled = false;
		}
		if (selection?.kind !== 'session') {
			this.statusDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			return;
		}
		this.statusDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
		try {
			const active = selection.active;
			const summaries = await this.chat.listTurnChanges(active.session.sessionId, active.threadId);
			const details = await Promise.all(summaries.filter(summary => summary.captureState !== 'discarded').map(summary => this.chat.readTurnChange(active.session.sessionId, active.threadId, summary.changeSetId)));
			if (this.isDisposed || request !== this.request) { return; }
			this.rows = details.flatMap((details, index) => details.files.map(file => ({ summary: details.summary, file, turnNumber: index + 1 })));
			this.tree.setChildren(this.rows.map(element => ({ element })));
			this.tree.setSelection(selectedIds.filter(id => this.rows.some(row => `${row.summary.changeSetId}:${row.file.path}` === id)));
			this.updatePreviewSelection();
			if (focused) { this.tree.setFocus(`${focused.summary.changeSetId}:${focused.file.path}`); }
			this.review.enabled = this.rows.some(row => !row.file.binary);
			this.statusDomNode.textContent = this.rows.length ? localize('sessions.changes.count', '{0} changed files', this.rows.length) : localize('sessions.changes.empty', 'No changes in this conversation.');
		} catch (error) {
			if (this.isDisposed || request !== this.request) { return; }
			this.statusDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', error instanceof Error ? error.message : String(error));
		}
	}

	private async openReview(): Promise<void> {
		const selection = this.sessions.activeSelection;
		if (selection?.kind !== 'session') { return; }
		const owner = this.owner;
		const input = await createTurnMultiDiffEditorInput(this.chat, selection.active, 'throughCurrentTurn');
		if (this.isDisposed || owner !== this.owner) { return; }
		await this.editors.openEditor(input, { pinned: true });
	}

	private async previewSelection(): Promise<void> {
		const selection = this.sessions.activeSelection;
		if (selection?.kind !== 'session') { return; }
		const owner = this.owner;
		const selected = this.tree.selection;
		const active = selection.active;
		const grouped = new Map<string, TurnCommitSelection>();
		for (const row of selected) {
			const existing = grouped.get(row.summary.changeSetId);
			grouped.set(row.summary.changeSetId, { changeSetId: row.summary.changeSetId, expectedRevision: row.summary.revision, paths: [...(existing?.paths ?? []), row.file.path] });
		}
		if (!grouped.size) { return; }
		const message = await this.quickInput.input({ title: localize('sessions.changes.commitMessage', 'Commit message'), validateInput: async value => value.trim() ? undefined : localize('sessions.changes.messageRequired', 'Enter a commit message.') });
		if (message === undefined || this.isDisposed || owner !== this.owner) { return; }
		const preview = await this.chat.prepareTurnCommit(active.session.sessionId, active.threadId, [...grouped.values()], message);
		const input = await createTurnCommitPreviewInput(this.chat, active.session.sessionId, active.threadId, preview);
		if (this.isDisposed || owner !== this.owner) { return; }
		await this.editors.openEditor(input, { pinned: true });
	}

	private async openFile(row: ChangeRow, options: IEditorOptions, sideBySide: boolean): Promise<void> {
		const owner = this.owner;
		if (row.file.binary) {
			this.notifications.info(localize('sessions.changes.binary', 'This is a binary file; text comparison is unavailable.'));
			return;
		}
		const summary = row.summary;
		const contents = await this.chat.readTurnChangeFile(summary.sessionId, summary.threadId, summary.changeSetId, row.file.path);
		if (this.isDisposed || owner !== this.owner) { return; }
		if (contents.truncated) { throw new Error(localize('sessions.changes.truncated', 'This change is too large to compare in full.')); }
		const resource = URI.from({ scheme: 'ash-turn-diff', path: `/${summary.changeSetId}/${row.file.path}` });
		await this.editors.openEditor(createDiffEditorInput(
			{ resource: resource.with({ query: 'before' }), initialText: contents.before ?? '', readOnly: true },
			{ resource: resource.with({ query: 'after' }), initialText: contents.after ?? '', readOnly: true },
			row.file.path,
		), options, sideBySide ? 'sideGroup' : 'activeGroup');
	}
}

function fileState(row: ChangeRow): string {
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
