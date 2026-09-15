import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../base/common/actions.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import type { IActiveSessionThread } from '../../../../sessions/services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../../sessions/services/sessions/common/sessionsManagementService.js';
import { EXPLORER_VIEW_ID } from '../../files/browser/files.contribution.js';
import type { IChatService, TurnChangeSetSummary } from '../../../services/chat/common/chatService.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IGitService } from '../../../services/git/common/gitService.js';
import type { IViewsService } from '../../../services/views/browser/viewsService.js';
import { createGitMultiDiffEditorInput } from './scmMultiDiffAction.js';
import type { GitMultiDiffScope, MultiDiffEditorInput, MultiDiffEditorSource } from './multiDiffEditorInput.js';
import { createTurnMultiDiffEditorInput, type TurnMultiDiffScope } from './turnMultiDiffSource.js';

export interface MultiDiffEditorToolbarOptions {
	readonly container: HTMLElement;
	readonly input: MultiDiffEditorInput;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly gitService?: IGitService;
	readonly chatService?: IChatService;
	readonly sessionsService?: ISessionsManagementService;
	readonly editorService?: IEditorService;
	readonly viewsService?: IViewsService;
	readonly collapseAll: () => void;
	readonly expandAll: () => void;
}

/** Owns the source selector, repository actions, and commit editor for a multi-diff pane. */
export class MultiDiffEditorToolbar extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly statusDomNode: HTMLDivElement;
	private readonly overlay = this._register(new MutableDisposable<DisposableStore>());
	private busy = false;

	constructor(private readonly options: MultiDiffEditorToolbarOptions, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		const ownerDocument = options.container.ownerDocument;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'stanza-multi-diff-editor-toolbar';
		const leftDomNode = h(ownerDocument, 'div');
		leftDomNode.className = 'stanza-multi-diff-editor-toolbar-left';
		const rightDomNode = h(ownerDocument, 'div');
		rightDomNode.className = 'stanza-multi-diff-editor-toolbar-right';
		this.statusDomNode = h(ownerDocument, 'div');
		this.statusDomNode.className = 'stanza-multi-diff-editor-toolbar-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.setAttribute('aria-live', 'polite');
		this.domNode.append(leftDomNode, this.statusDomNode, rightDomNode);
		options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.createSourceToolbar(leftDomNode);
		this.createRepositoryToolbar(rightDomNode);
	}

	private createSourceToolbar(container: HTMLElement): void {
		const primary = new ToolbarAction('multiDiff.source', sourceLabel(this.options.input.source), 'Select change source', undefined, true, () => this.selectCurrentSource());
		const dropdown = new ToolbarAction('multiDiff.source.menu', 'Select Changes', 'Select Changes', lxiconsLibrary.chevronDown, true, () => {});
		const actions: readonly IAction[] = [
			new ToolbarAction('multiDiff.source.currentTurn', 'Current Turn', 'Show the current Turn', undefined, this.canOpenTurns(), () => this.openTurnSource('currentTurn')),
			new ToolbarAction('multiDiff.source.throughCurrentTurn', 'Current Turn and Earlier', 'Show all changes through the current Turn', undefined, this.canOpenTurns(), () => this.openTurnSource('throughCurrentTurn')),
			new ToolbarAction('multiDiff.source.previousTurn', 'Previous Turn', 'Show the previous Turn', undefined, this.canOpenTurns(), () => this.openTurnSource('previousTurn')),
			new ToolbarAction('multiDiff.source.staged', 'Stage', 'Show staged changes', undefined, this.canOpenGit(), () => this.openGitSource('staged')),
			new ToolbarAction('multiDiff.source.unstaged', 'Unstage', 'Show unstaged changes', undefined, this.canOpenGit(), () => this.openGitSource('unstaged')),
			new ToolbarAction('multiDiff.source.uncommitted', 'Uncommitted', 'Show every uncommitted change', undefined, this.canOpenGit(), () => this.openGitSource('uncommitted')),
		];
		const toolbar = this._register(new WorkbenchToolBar(container, this.options.contextMenuProvider, {
			ariaLabel: 'Multi-diff change source',
			actionViewItemProvider: action => action.id === primary.id
				? new DropdownWithPrimaryActionViewItem(primary, dropdown, actions, this.options.contextMenuProvider)
				: undefined,
		}));
		toolbar.setActions([primary]);
		toolbar.element.classList.add('stanza-multi-diff-editor-source-toolbar');
	}

	private createRepositoryToolbar(container: HTMLElement): void {
		const isMain = isMainBranch(sourceBranch(this.options.input.source));
		const primary = isMain
			? new ToolbarAction('multiDiff.commit.auto', 'Commit', 'Generate a commit message and commit the selected Turn changes', lxiconsLibrary.gitCommit, this.canOpenTurns(), () => this.autoCommit())
			: new ToolbarAction('multiDiff.pullRequest.create', 'Create Pull Request', 'Pull request provider is not connected', lxiconsLibrary.git, false, () => {});
		const dropdown = new ToolbarAction('multiDiff.repository.menu', 'Repository Actions', 'Repository Actions', lxiconsLibrary.chevronDown, true, () => {});
		const actions = isMain ? this.commitActions() : this.pullRequestActions();
		const files = new ToolbarAction('multiDiff.files', 'Files', 'Open Files', lxiconsLibrary.files, this.options.viewsService !== undefined, () => this.options.viewsService?.focusView(EXPLORER_VIEW_ID));
		const secondary = [
			new ToolbarAction('multiDiff.collapseAll', 'Collapse All', 'Collapse all diffs', lxiconsLibrary.fold, true, this.options.collapseAll),
			new ToolbarAction('multiDiff.expandAll', 'Expand All', 'Expand all diffs', lxiconsLibrary.unfold, true, this.options.expandAll),
			new ToolbarAction('multiDiff.stageAll', 'Stage All', 'Stage all changes in this source', lxiconsLibrary.check, this.canOpenGit(), () => this.stageAll()),
			new ToolbarAction('multiDiff.discardAll', 'Discard All', 'Discard all working-tree changes in this source', lxiconsLibrary.discard, this.canOpenGit(), () => this.discardAll()),
		];
		const toolbar = this._register(new WorkbenchToolBar(container, this.options.contextMenuProvider, {
			ariaLabel: 'Multi-diff repository actions',
			actionViewItemProvider: action => action.id === primary.id
				? new DropdownWithPrimaryActionViewItem(primary, dropdown, actions, this.options.contextMenuProvider)
				: undefined,
		}));
		toolbar.setActions([primary, files], secondary);
		toolbar.element.classList.add('stanza-multi-diff-editor-repository-toolbar');
	}

	private commitActions(): readonly IAction[] {
		return [
			new ToolbarAction('multiDiff.commit.manual', 'Commit', 'Enter a commit message', lxiconsLibrary.gitCommit, this.options.gitService !== undefined, () => this.showCommitEditor(false)),
			new ToolbarAction('multiDiff.commitAndPush', 'Commit and Push', 'Commit and push', lxiconsLibrary.repoPush, this.options.gitService !== undefined, () => this.showCommitEditor(true)),
			new ToolbarAction('multiDiff.push', 'Push', 'Push the current branch', lxiconsLibrary.repoPush, this.options.gitService !== undefined, () => this.run('Pushing…', async () => {
				await this.options.gitService!.push(this.repositoryId());
				return 'Pushed the current branch.';
			})),
		];
	}

	private pullRequestActions(): readonly IAction[] {
		return [
			new ToolbarAction('multiDiff.pullRequest.autoMerge', 'Auto Merge', 'Pull request provider is not connected', undefined, false, () => {}),
			new ToolbarAction('multiDiff.pullRequest.autoSquash', 'Auto Squash', 'Pull request provider is not connected', undefined, false, () => {}),
			new ToolbarAction('multiDiff.pullRequest.autoRebase', 'Auto Rebase', 'Pull request provider is not connected', undefined, false, () => {}),
			new ToolbarAction('multiDiff.pullRequest.draft', 'Create Draft PR', 'Pull request provider is not connected', undefined, false, () => {}),
		];
	}

	private selectCurrentSource(): Promise<void> {
		const source = this.options.input.source;
		if (source?.kind === 'turn') return this.openTurnSource(source.scope);
		return this.openGitSource(source?.scope ?? 'uncommitted');
	}

	private async openTurnSource(scope: TurnMultiDiffScope): Promise<void> {
		const active = this.activeSession();
		const chatService = this.options.chatService;
		if (!active || !chatService || !this.options.editorService) return;
		await this.run('Loading Turn changes…', async () => {
			const input = await createTurnMultiDiffEditorInput(chatService, active, scope);
			await this.options.editorService!.openEditor(input, { pinned: true });
			return '';
		});
	}

	private async openGitSource(scope: GitMultiDiffScope): Promise<void> {
		if (!this.options.gitService || !this.options.editorService) return;
		await this.run('Loading Git changes…', async () => {
			const input = await createGitMultiDiffEditorInput(this.options.gitService!, scope);
			await this.options.editorService!.openEditor(input, { pinned: true });
			return '';
		});
	}

	private async autoCommit(): Promise<void> {
		const chatService = this.options.chatService;
		if (!chatService) return;
		await this.run('Generating commit message…', async () => {
			const source = this.options.input.source;
			const active = this.activeSession();
			const sessionId = source?.kind === 'turn' ? source.sessionId : active?.session.sessionId;
			const threadId = source?.kind === 'turn' ? source.threadId : active?.threadId;
			if (!sessionId || !threadId) throw new Error('No active Turn is available to commit.');
			const listed = await chatService.listTurnChanges(sessionId, threadId);
			const requestedIds = source?.kind === 'turn' ? new Set(source.changeSetIds) : undefined;
			const selected = listed.filter(changeSet => (requestedIds?.has(changeSet.changeSetId) ?? changeSet.repositoryId === this.repositoryId()) && changeSet.captureState !== 'discarded' && changeSet.commitState !== 'committed');
			if (selected.length === 0) throw new Error('No sealed Turn changes are available to commit.');
			for (const changeSet of selected) await this.commitChangeSet(chatService, changeSet);
			return selected.length === 1 ? 'Committed the selected Turn.' : `Committed ${selected.length} Turns.`;
		});
	}

	private async commitChangeSet(chatService: IChatService, initial: TurnChangeSetSummary): Promise<void> {
		if (initial.captureState !== 'sealed') throw new Error('The selected Turn is still running and cannot be committed.');
		let summary = initial;
		let details = await chatService.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId);
		if (!details.draftMessage?.trim()) {
			if (summary.messageState === 'unconfigured') throw new Error('Configure and authorize a commit-message model before using automatic commit.');
			const updates = await chatService.generateTurnChangeMessage(summary.sessionId, summary.threadId, summary.changeSetId, summary.revision);
			summary = updates.find(candidate => candidate.changeSetId === summary.changeSetId) ?? summary;
			summary = await this.waitForGeneratedMessage(chatService, summary);
			details = await chatService.readTurnChange(summary.sessionId, summary.threadId, summary.changeSetId);
			const message = details.draftMessage?.trim() || details.generatedMessage?.trim();
			if (!message) throw new Error('The commit-message model did not produce a message.');
			if (!details.draftMessage?.trim()) {
				const draftUpdates = await chatService.updateTurnChangeDraft(summary.sessionId, summary.threadId, summary.changeSetId, summary.revision, message);
				summary = draftUpdates.find(candidate => candidate.changeSetId === summary.changeSetId) ?? summary;
			}
		}
		await chatService.commitTurnChange(summary.sessionId, summary.threadId, summary.changeSetId, summary.revision);
	}

	private waitForGeneratedMessage(chatService: IChatService, summary: TurnChangeSetSummary): Promise<TurnChangeSetSummary> {
		if (summary.messageState === 'ready') return Promise.resolve(summary);
		if (summary.messageState === 'failed' || summary.messageState === 'unconfigured') return Promise.reject(new Error('Commit-message generation failed.'));
		return new Promise((resolve, reject) => {
			const listener = chatService.onDidUpdateTurnChanges(update => {
				if (update.sessionId !== summary.sessionId || update.threadId !== summary.threadId) return;
				const next = update.changeSets.find(candidate => candidate.changeSetId === summary.changeSetId);
				if (!next || next.messageState === 'queued' || next.messageState === 'generating') return;
				listener.dispose();
				if (next.messageState === 'ready') resolve(next);
				else reject(new Error('Commit-message generation failed.'));
			});
		});
	}

	private showCommitEditor(pushAfterCommit: boolean): void {
		if (!this.options.gitService || this.busy) return;
		this.overlay.clear();
		const store = new DisposableStore();
		this.overlay.value = store;
		const ownerDocument = this.domNode.ownerDocument;
		const overlayDomNode = h(ownerDocument, 'div');
		overlayDomNode.className = 'stanza-multi-diff-commit-overlay';
		const dialogDomNode = h(ownerDocument, 'section');
		dialogDomNode.className = 'stanza-multi-diff-commit-dialog';
		dialogDomNode.setAttribute('role', 'dialog');
		dialogDomNode.setAttribute('aria-modal', 'true');
		dialogDomNode.setAttribute('aria-label', 'Commit changes');
		const headingDomNode = h(ownerDocument, 'h2');
		headingDomNode.textContent = 'Commit changes';
		const editorHostDomNode = h(ownerDocument, 'div');
		editorHostDomNode.className = 'stanza-multi-diff-commit-editor';
		const editor = store.add(this.instantiationService.createInstance(CommitMessageEditor, editorHostDomNode));
		const includeDomNode = h(ownerDocument, 'label');
		includeDomNode.className = 'stanza-multi-diff-include-unstaged';
		const includeInputDomNode = h(ownerDocument, 'input');
		includeInputDomNode.type = 'checkbox';
		includeDomNode.append(includeInputDomNode, ownerDocument.createTextNode(' Include unstaged changes'));
		const actionsDomNode = h(ownerDocument, 'div');
		actionsDomNode.className = 'stanza-multi-diff-commit-actions';
		const cancel = store.add(new Button(actionsDomNode, { label: 'Cancel', presentation: 'secondary', onClick: () => this.overlay.clear() }));
		const commit = store.add(new Button(actionsDomNode, { label: 'Commit', presentation: 'primary', icon: lxiconsLibrary.gitCommit, onClick: () => void this.commitFromEditor(editor.value, includeInputDomNode.checked, false) }));
		const commitAndPush = store.add(new Button(actionsDomNode, { label: 'Commit and Push', presentation: 'primary', icon: lxiconsLibrary.repoPush, onClick: () => void this.commitFromEditor(editor.value, includeInputDomNode.checked, true) }));
		commit.domNode.hidden = pushAfterCommit;
		commitAndPush.domNode.hidden = !pushAfterCommit;
		dialogDomNode.append(headingDomNode, editorHostDomNode, includeDomNode, actionsDomNode);
		overlayDomNode.append(dialogDomNode);
		this.options.container.append(overlayDomNode);
		store.add(toDisposable(() => overlayDomNode.remove()));
		store.add(addDisposableListener(overlayDomNode, 'mousedown', event => {
			if (event.target === overlayDomNode) this.overlay.clear();
		}));
		store.add(addDisposableListener(overlayDomNode, 'keydown', event => {
			if (event.key !== 'Escape') return;
			stopEvent(event);
			this.overlay.clear();
		}));
		queueMicrotask(() => {
			editor.layout();
			editor.focus();
		});
		void cancel;
	}

	private async commitFromEditor(message: string, includeUnstaged: boolean, push: boolean): Promise<void> {
		const trimmed = message.trim();
		if (!trimmed) {
			this.statusDomNode.textContent = 'Enter a commit message.';
			return;
		}
		await this.run(push ? 'Committing and pushing…' : 'Committing…', async () => {
			const gitService = this.options.gitService!;
			const repositoryId = this.repositoryId();
			if (includeUnstaged) {
				const status = await gitService.status(repositoryId);
				const paths = uniquePaths(status.changes.filter(change => change.worktreeStatus !== 'unmodified').map(change => change.path));
				if (paths.length > 0) await gitService.stage(paths, repositoryId);
			}
			const result = await gitService.commit(trimmed, repositoryId);
			if (push) await gitService.push(repositoryId);
			this.overlay.clear();
			return `${push ? 'Committed and pushed' : 'Committed'} ${result.objectId.slice(0, 7)}.`;
		});
	}

	private async stageAll(): Promise<void> {
		if (!this.options.gitService) return;
		await this.run('Staging changes…', async () => {
			const status = await this.options.gitService!.status(this.repositoryId());
			const paths = uniquePaths(status.changes.filter(change => change.worktreeStatus !== 'unmodified').map(change => change.path));
			if (paths.length > 0) await this.options.gitService!.stage(paths, status.repositoryId);
			return paths.length === 0 ? 'No unstaged changes.' : `Staged ${paths.length} files.`;
		});
	}

	private async discardAll(): Promise<void> {
		if (!this.options.gitService) return;
		const confirmed = this.domNode.ownerDocument.defaultView?.confirm('Discard all working-tree changes in this source? This cannot be undone.') === true;
		if (!confirmed) return;
		await this.run('Discarding changes…', async () => {
			const status = await this.options.gitService!.status(this.repositoryId());
			const paths = uniquePaths(status.changes.filter(change => change.worktreeStatus !== 'unmodified').map(change => change.path));
			if (paths.length > 0) await this.options.gitService!.discardWorktree(paths, status.repositoryId);
			return paths.length === 0 ? 'No working-tree changes.' : `Discarded changes in ${paths.length} files.`;
		});
	}

	private async run(progress: string, operation: () => Promise<string>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.domNode.classList.add('busy');
		this.statusDomNode.textContent = progress;
		try {
			this.statusDomNode.textContent = await operation();
		} catch (error) {
			this.statusDomNode.textContent = error instanceof Error ? error.message : 'The operation failed.';
		} finally {
			this.busy = false;
			this.domNode.classList.remove('busy');
		}
	}

	private repositoryId(): string | undefined {
		return this.options.input.source?.repositoryId;
	}

	private activeSession(): IActiveSessionThread | undefined {
		return this.options.sessionsService?.active;
	}

	private canOpenGit(): boolean {
		return this.options.gitService !== undefined && this.options.editorService !== undefined;
	}

	private canOpenTurns(): boolean {
		return this.options.chatService !== undefined && this.options.sessionsService?.active !== undefined && this.options.editorService !== undefined;
	}
}

class CommitMessageEditor extends Disposable {
	readonly model = this._register(new TextModel());
	private readonly editor: CodeEditorWidget;

	constructor(private readonly container: HTMLElement, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container,
			model: this.model,
			input: { resource: this.model.uri },
			languageId: this.model.getLanguageId(),
			lineHeight: 20,
			ariaLabel: 'Commit message',
			placeholder: 'Commit message',
		}));
	}

	get value(): string {
		return this.model.getText();
	}

	focus(): void {
		this.editor.focus();
	}

	layout(): void {
		this.editor.layout({ width: Math.max(0, this.container.clientWidth), height: Math.max(0, this.container.clientHeight) });
	}

	set value(value: string) {
		const range = Range.fromPositions(new Position(1, 1), this.model.positionAt(this.model.length));
		this.model.applyEdits([{ range, text: value }]);
	}
}

class ToolbarAction implements IAction {
	readonly checked = undefined;

	constructor(
		readonly id: string,
		readonly label: string,
		readonly tooltip: string,
		readonly icon: IAction['icon'],
		readonly enabled: boolean,
		private readonly execute: () => unknown,
	) {}

	run(): unknown {
		return this.execute();
	}
}

function sourceLabel(source: MultiDiffEditorSource | undefined): string {
	if (!source) return 'Changes';
	if (source.kind === 'turn') {
		if (source.scope === 'currentTurn') return 'Current Turn';
		if (source.scope === 'previousTurn') return 'Previous Turn';
		return 'Current Turn and Earlier';
	}
	if (source.scope === 'staged') return 'Stage';
	if (source.scope === 'unstaged') return 'Unstage';
	return 'Uncommitted';
}

function sourceBranch(source: MultiDiffEditorSource | undefined): string | undefined {
	return source?.kind === 'turn' ? source.targetBranch : source?.branchName;
}

function isMainBranch(branch: string | undefined): boolean {
	return branch === undefined || branch === 'main' || branch === 'master';
}

function uniquePaths(paths: readonly string[]): readonly string[] {
	return [...new Set(paths)];
}
