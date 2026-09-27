import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { text, addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { VIEW_ID } from '../../files/common/files.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IGitService } from '../../../services/git/common/gitService.js';
import type { IViewsService } from '../../../services/views/browser/viewsService.js';
import { createGitMultiDiffEditorInput } from './scmMultiDiffAction.js';
import { createMultiDiffEditorInput, type GitMultiDiffScope, type MultiDiffEditorInput, type MultiDiffEditorSource } from './multiDiffEditorInput.js';
import { IMultiDiffSourceResolverService } from './multiDiffSourceResolverService.js';

export interface MultiDiffEditorToolbarOptions {
	readonly container: HTMLElement;
	readonly input: MultiDiffEditorInput;
	readonly contextMenuProvider: IContextMenuProvider;
	readonly gitService?: IGitService;
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

	constructor(private readonly options: MultiDiffEditorToolbarOptions, @IInstantiationService private readonly instantiationService: IInstantiationService, @IDialogService private readonly dialogs: IDialogService, @IMultiDiffSourceResolverService private readonly sourceResolvers: IMultiDiffSourceResolverService) {
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
		const dropdown = new ToolbarAction('multiDiff.source.menu', 'Select Changes', 'Select Changes', Lxicon.chevronDown, true, () => {});
		const actions: readonly IAction[] = [
			...this.sourceResolvers.sourceActions().map(action => this.wrapExternalAction(action, 'Loading changes…')),
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
		const contributedPrimary = this.sourceResolvers.primaryRepositoryAction(this.options.input);
		const primary = isMain
			? contributedPrimary
				? this.wrapExternalAction(contributedPrimary, 'Committing…')
				: new ToolbarAction('multiDiff.commit.manual', 'Commit', 'Enter a commit message', Lxicon.gitCommit, this.options.gitService !== undefined, () => this.showCommitEditor(false))
			: new ToolbarAction('multiDiff.pullRequest.create', 'Create Pull Request', 'Pull request provider is not connected', Lxicon.git, false, () => {});
		const dropdown = new ToolbarAction('multiDiff.repository.menu', 'Repository Actions', 'Repository Actions', Lxicon.chevronDown, true, () => {});
		const actions = isMain ? this.commitActions() : this.pullRequestActions();
		const files = new ToolbarAction('multiDiff.files', 'Files', 'Open Files', Lxicon.files, this.options.viewsService !== undefined, () => this.options.viewsService?.focusView(VIEW_ID));
		const secondary = [
			new ToolbarAction('multiDiff.collapseAll', 'Collapse All', 'Collapse all diffs', Lxicon.fold, true, this.options.collapseAll),
			new ToolbarAction('multiDiff.expandAll', 'Expand All', 'Expand all diffs', Lxicon.unfold, true, this.options.expandAll),
			new ToolbarAction('multiDiff.stageAll', 'Stage All', 'Stage all changes in this source', Lxicon.check, this.canOpenGit(), () => this.stageAll()),
			new ToolbarAction('multiDiff.discardAll', 'Discard All', 'Discard all working-tree changes in this source', Lxicon.discard, this.canOpenGit(), () => this.discardAll()),
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
			new ToolbarAction('multiDiff.commit.manual', 'Commit', 'Enter a commit message', Lxicon.gitCommit, this.options.gitService !== undefined, () => this.showCommitEditor(false)),
			new ToolbarAction('multiDiff.commitAndPush', 'Commit and Push', 'Commit and push', Lxicon.repoPush, this.options.gitService !== undefined, () => this.showCommitEditor(true)),
			new ToolbarAction('multiDiff.push', 'Push', 'Push the current branch', Lxicon.repoPush, this.options.gitService !== undefined, () => this.run('Pushing…', async () => {
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

	private async selectCurrentSource(): Promise<void> {
		const source = this.options.input.source;
		if (source?.kind === 'external') {
			const resolved = await this.sourceResolvers.resolve(this.options.input.resource);
			if (!resolved) throw new Error('No resolver is registered for this multi-diff source.');
			if (!this.options.editorService) throw new Error('Multi-diff source opening requires the Workbench editor service.');
			await this.options.editorService.openEditor(createMultiDiffEditorInput(resolved.resource, resolved.resources, resolved.label, resolved.source), { pinned: true });
			return;
		}
		return this.openGitSource(source?.scope ?? 'uncommitted');
	}

	private async openGitSource(scope: GitMultiDiffScope): Promise<void> {
		if (!this.options.gitService || !this.options.editorService) return;
		await this.run('Loading Git changes…', async () => {
			const input = await createGitMultiDiffEditorInput(this.options.gitService!, scope);
			await this.options.editorService!.openEditor(input, { pinned: true });
			return '';
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
		includeDomNode.append(includeInputDomNode, text(ownerDocument, ' Include unstaged changes'));
		const actionsDomNode = h(ownerDocument, 'div');
		actionsDomNode.className = 'stanza-multi-diff-commit-actions';
		const cancel = store.add(new Button(actionsDomNode, { label: 'Cancel', presentation: 'secondary', onClick: () => this.overlay.clear() }));
		const commit = store.add(new Button(actionsDomNode, { label: 'Commit', presentation: 'primary', icon: Lxicon.gitCommit, onClick: () => void this.commitFromEditor(editor.value, includeInputDomNode.checked, false) }));
		const commitAndPush = store.add(new Button(actionsDomNode, { label: 'Commit and Push', presentation: 'primary', icon: Lxicon.repoPush, onClick: () => void this.commitFromEditor(editor.value, includeInputDomNode.checked, true) }));
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
		const confirmation = await this.dialogs.confirm({
			message: 'Discard all working-tree changes in this source? This cannot be undone.',
			primaryButton: 'Discard Changes',
		});
		if (!confirmation.confirmed || this.isDisposed) return;
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

	private wrapExternalAction(action: IAction, progress: string): ToolbarAction {
		return new ToolbarAction(action.id, action.label, action.tooltip, action.icon, action.enabled, () => this.run(progress, async () => {
			const result: unknown = await action.run();
			return typeof result === 'string' ? result : '';
		}));
	}

	private canOpenGit(): boolean {
		return this.options.gitService !== undefined && this.options.editorService !== undefined;
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
	if (source.kind === 'external') return source.label;
	if (source.scope === 'staged') return 'Stage';
	if (source.scope === 'unstaged') return 'Unstage';
	return 'Uncommitted';
}

function sourceBranch(source: MultiDiffEditorSource | undefined): string | undefined {
	return source?.branchName;
}

function isMainBranch(branch: string | undefined): boolean {
	return branch === undefined || branch === 'main' || branch === 'master';
}

function uniquePaths(paths: readonly string[]): readonly string[] {
	return [...new Set(paths)];
}
