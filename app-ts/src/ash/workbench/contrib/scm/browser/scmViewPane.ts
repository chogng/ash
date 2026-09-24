import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ButtonActionViewItem, type ActionViewItemOptions } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { IconLabel } from "../../../../base/browser/ui/iconlabel/iconlabel.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { IAction } from "../../../../base/common/actions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { WorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import type { ICommandService } from "../../../../platform/commands/common/commands.js";
import type { IFileIconThemeService } from "../../../../platform/theme/browser/fileIconThemeService.js";
import type { GitChangeFileComparison, GitChangeStatus, GitRepositoryChange, GitStatus, IGitService } from "../../../services/git/common/gitService.js";
import type { IEditorService } from "../../../services/editor/common/editorService.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { createDiffEditorInput } from "../../codeEditor/browser/diffEditorInput.js";
import { OpenScmMultiDiffEditorCommandId, type OpenScmMultiDiffEditorOptions, type OpenScmMultiDiffEditorResult } from "../../multiDiffEditor/browser/scmMultiDiffAction.js";
import { repositoryFileUri, resolveGitChangeInputs } from "./scmChangeEditorInput.js";
import { gitErrorMessage } from "./scmError.js";

type GitChangeSide = "index" | "worktree";
type GitPathAction = "stage" | "unstage" | "discard";

export const GIT_VIEW_ID = 'ash.gitView';

/** Git status and user mutations routed through the workspace App Server. */
export class ScmViewPane extends ViewPane {
	private readonly gitService: IGitService;
	private readonly repositorySelectorContainer: HTMLLabelElement;
	private readonly repositorySelector: HTMLSelectElement;
	private readonly commitInput: HTMLTextAreaElement;
	private readonly commitButton: HTMLButtonElement;
	private readonly statusElement: HTMLDivElement;
	private readonly changesElement: HTMLDivElement;
	private readonly renderedChanges = this._register(new DisposableStore());
	private readonly actionViewItems: ScmActionViewItem[] = [];
	private status: GitStatus | undefined;
	private readonly retiredStreamInstanceIds = new Set<string>();
	private revision = 0;
	private busy = false;
	private unavailable = false;

	constructor(container: HTMLElement, options: IViewPaneOptions, gitService: IGitService, private readonly fileIconThemeService: IFileIconThemeService, private readonly editorService: IEditorService, private readonly commandService: ICommandService, private readonly contextMenuProvider: IContextMenuProvider) {
		super(container, options);
		this.gitService = gitService;
		this.contentElement.classList.add("ash-scm");
		const document = container.ownerDocument;
		this.repositorySelectorContainer = h(document, "label");
		this.repositorySelectorContainer.className = "ash-scm-repository-selector";
		const repositorySelectorLabel = h(document, "span");
		repositorySelectorLabel.textContent = "Repository";
		this.repositorySelector = h(document, "select");
		this.repositorySelector.setAttribute("aria-label", "Active source control repository");
		this.repositorySelectorContainer.append(repositorySelectorLabel, this.repositorySelector);
		const commitForm = h(document, "form");
		commitForm.className = "ash-scm-commit-form";
		this.commitInput = h(document, "textarea");
		this.commitInput.className = "ash-scm-commit-input";
		this.commitInput.name = "commitMessage";
		this.commitInput.rows = 2;
		this.commitInput.placeholder = "Message (Ctrl+Enter to commit)";
		this.commitInput.setAttribute("aria-label", "Commit message");
		const commitButton = this._register(new Button(commitForm, {
			label: "Commit",
			icon: lxiconsLibrary.check,
			contentAlignment: "labelCentered",
			type: "submit",
			title: "Commit staged changes",
		}));
		commitButton.toggleClassName("ash-scm-commit", true);
		this.commitButton = commitButton.domNode;
		commitForm.append(this.commitInput, this.commitButton);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-scm-status ash-aria-live";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.statusElement.textContent = "Reading Git status…";
		this.changesElement = h(document, "div");
		this.changesElement.className = "ash-scm-changes";
		this.contentElement.append(this.repositorySelectorContainer, commitForm, this.statusElement, this.changesElement);
		this._register(addDisposableListener(this.repositorySelector, "change", () => void this.selectRepository(this.repositorySelector.value)));
		this._register(addDisposableListener(commitForm, "submit", (event) => {
			event.preventDefault();
			void this.commit();
		}));
		this._register(addDisposableListener(this.commitInput, "keydown", (event) => {
			const keyboardEvent = event as KeyboardEvent;
			if (keyboardEvent.key === "Enter" && (keyboardEvent.ctrlKey || keyboardEvent.metaKey)) {
				event.preventDefault();
				void this.commit();
			}
		}));
		this._register(this.gitService.onDidChangeStatus((status) => this.onStatusChanged(status)));
		this._register(this.gitService.onDidChangeRepositories(() => this.renderRepositorySelector()));
		this._register(this.gitService.onDidChangeActiveRepository(() => this.renderRepositorySelector()));
		this._register(this.gitService.onDidBecomeReady(() => void this.refresh()));
		this._register(this.fileIconThemeService.onDidFileIconThemeChange(() => {
			if (this.status) this.renderStatus(this.status);
		}));
		this._register(toDisposable(() => {
			this.revision += 1;
		}));
		this.setBusy(true);
		this.renderRepositorySelector();
		void this.refresh();
	}

	private async selectRepository(repositoryId: string): Promise<void> {
		if (!repositoryId || repositoryId === this.gitService.activeRepository?.id) return;
		const revision = ++this.revision;
		this.setBusy(true);
		this.statusElement.textContent = "Switching repository…";
		try {
			const status = await this.gitService.selectRepository(repositoryId);
			if (this.isDisposed || revision !== this.revision) return;
			this.renderStatus(status);
		} catch (error) {
			this.renderError(error, revision);
		} finally {
			if (!this.isDisposed && revision === this.revision) this.setBusy(false);
			this.renderRepositorySelector();
		}
	}

	async refresh(): Promise<void> {
		const revision = ++this.revision;
		this.setBusy(true);
		this.statusElement.textContent = "Reading Git status…";
		try {
			const status = await this.gitService.status();
			if (this.isDisposed || revision !== this.revision) return;
			this.renderStatus(status);
		} catch (error) {
			this.renderError(error, revision);
		} finally {
			if (!this.isDisposed && revision === this.revision) this.setBusy(false);
		}
	}

	private async commit(): Promise<void> {
		const message = this.commitInput.value.trim();
		if (!message) {
			this.statusElement.textContent = "Enter a commit message.";
			this.commitInput.focus();
			return;
		}
		const revision = ++this.revision;
		const repositoryId = this.status?.repositoryId;
		this.setBusy(true);
		this.statusElement.textContent = "Committing staged changes…";
		try {
			const result = await this.gitService.commit(message, repositoryId);
			if (this.isDisposed || revision !== this.revision) return;
			this.commitInput.value = "";
			this.renderStatus(result.status, `Created commit ${result.objectId.slice(0, 7)}.`);
		} catch (error) {
			this.renderError(error, revision);
		} finally {
			if (!this.isDisposed && revision === this.revision) this.setBusy(false);
		}
	}

	private requestPathAction(action: GitPathAction, paths: readonly string[]): void {
		if (this.busy || paths.length === 0) return;
		if (action === "discard") {
			const target = paths.length === 1 ? paths[0] : `${paths.length} working-tree files`;
			const confirmed = this.element.ownerDocument.defaultView?.confirm(
				`Discard changes in ${target}? This cannot be undone.`,
			) === true;
			if (!confirmed) return;
		}
		void this.runPathAction(action, paths);
	}

	private async runPathAction(action: GitPathAction, paths: readonly string[]): Promise<void> {
		const revision = ++this.revision;
		const repositoryId = this.status?.repositoryId;
		this.setBusy(true);
		this.statusElement.textContent = `${pathActionLabel(action)} ${paths.length === 1 ? paths[0] : `${paths.length} paths`}…`;
		try {
			const result = action === "stage"
				? await this.gitService.stage(paths, repositoryId)
				: action === "unstage"
				? await this.gitService.unstage(paths, repositoryId)
				: await this.gitService.discardWorktree(paths, repositoryId);
			if (this.isDisposed || revision !== this.revision) return;
			this.renderStatus(result);
		} catch (error) {
			this.renderError(error, revision);
		} finally {
			if (!this.isDisposed && revision === this.revision) this.setBusy(false);
		}
	}

	private onStatusChanged(status: GitStatus): void {
		if (this.isDisposed) return;
		if (
			this.status &&
			status.streamInstanceId === this.status.streamInstanceId &&
			status.revision <= this.status.revision
		) return;
		this.renderStatus(status);
	}

	private renderStatus(status: GitStatus, announcement?: string): void {
		if (this.status) {
			if (status.streamInstanceId === this.status.streamInstanceId) {
				if (status.revision < this.status.revision) return;
			} else {
				if (this.retiredStreamInstanceIds.has(status.streamInstanceId)) return;
				this.retiredStreamInstanceIds.add(this.status.streamInstanceId);
			}
		}
		this.status = status;
		this.unavailable = false;
		this.actionViewItems.length = 0;
		this.renderedChanges.clear();
		this.changesElement.replaceChildren();
		const conflicts = status.changes.filter((change) => change.conflicted);
		const staged = status.changes.filter((change) => !change.conflicted && change.indexStatus !== "unmodified");
		const working = status.changes.filter((change) => !change.conflicted && change.worktreeStatus !== "unmodified");
		const summary = conflicts.length === 0 && staged.length === 0 && working.length === 0
			? "No changes."
			: `${status.changes.length} changed ${status.changes.length === 1 ? "file" : "files"}`;
		this.statusElement.textContent = announcement ? `${announcement} ${summary}` : summary;
		this.appendSection("Merge Changes", conflicts, "worktree");
		this.appendSection("Staged Changes", staged, "index");
		this.appendSection("Changes", working, "worktree");
		this.updateCommandState();
	}

	private appendSection(title: string, changes: readonly GitRepositoryChange[], side: GitChangeSide): void {
		if (changes.length === 0) return;
		const document = this.element.ownerDocument;
		const section = h(document, "section");
		section.className = "ash-scm-section";
		const heading = h(document, "h3");
		heading.className = "ash-scm-section-heading";
		heading.tabIndex = 0;
		const label = h(document, "span");
		label.className = "ash-scm-section-label";
		label.textContent = title;
		heading.append(label);
		const actions = this.renderActionToolbar(
			heading,
			[
				...(changes.some((change) => !change.conflicted) ? [this.viewChangesAction(title, changes, side)] : []),
				...sectionActions(title, changes, side).map((action) => this.pathAction(action.id, action.label, action.action, action.paths)),
			],
			`${title} actions`,
		);
		actions.classList.add("ash-scm-section-actions");
		const count = h(document, "span");
		count.className = "ash-scm-section-count";
		count.textContent = String(changes.length);
		heading.append(count);
		const list = h(document, "ul");
		list.className = "ash-scm-list";
		for (const change of changes) list.append(this.renderChange(change, side));
		section.append(heading, list);
		this.changesElement.append(section);
	}

	private renderChange(change: GitRepositoryChange, side: GitChangeSide): HTMLLIElement {
		const document = this.element.ownerDocument;
		const item = h(document, "li");
		item.className = "ash-scm-change";
		const open = h(document, "button");
		open.type = "button";
		open.className = "ash-scm-change-open";
		const name = basename(change.path);
		const parentPath = dirname(change.path);
		const fileLabel = this.renderedChanges.add(new IconLabel(open, {
			label: name,
			description: parentPath || undefined,
			reserveIconSpace: true,
			renderIcon: (container) => this.fileIconThemeService.renderFileIcon(repositoryFileUri(this.status?.workspacePath, change.path), container),
			title: change.originalPath ? `${change.originalPath} → ${change.path}` : change.path,
		}));
		fileLabel.element.classList.add("ash-scm-change-label");
		fileLabel.element.querySelector(".ash-icon-label-description")?.classList.add("ash-scm-change-description");
		open.setAttribute("aria-label", `Open ${side === "index" ? "staged changes" : "changes"} for ${change.path}`);
		open.append(fileLabel.element);
		if (change.conflicted) {
			open.disabled = true;
			open.setAttribute("aria-label", `Merge conflict in ${change.path}`);
		} else {
			this.renderedChanges.add(addDisposableListener(open, "click", (event) => {
				if ((event as MouseEvent).detail > 1) return;
				void this.openChange(change, side, false);
			}));
			this.renderedChanges.add(addDisposableListener(open, "dblclick", () => {
				void this.openChange(change, side, true);
			}));
		}
		const actions = side === "index"
			? [this.pathAction(`scm.change.unstage.${change.path}`, `Unstage ${change.path}`, "unstage", changePaths(change))]
			: [
				...(isDiscardable(change) ? [this.pathAction(`scm.change.discard.${change.path}`, `Discard ${change.path}`, "discard", [change.path])] : []),
				this.pathAction(`scm.change.stage.${change.path}`, `Stage ${change.path}`, "stage", changePaths(change)),
			];
		item.append(open);
		const toolbar = this.renderActionToolbar(item, actions, `Actions for ${change.path}`);
		toolbar.classList.add("ash-scm-change-actions");
		const status = side === "index" ? change.indexStatus : change.worktreeStatus;
		const badge = h(document, "span");
		badge.className = `ash-scm-change-status status-${status}`;
		badge.textContent = statusCode(status);
		badge.title = statusLabel(status);
		item.append(badge);
		return item;
	}

	private async openChange(change: GitRepositoryChange, side: GitChangeSide, pinned: boolean): Promise<void> {
		const status = this.status;
		if (!status) return;
		const comparison: GitChangeFileComparison = side === "index" ? "staged" : "unstaged";
		try {
			const inputs = await resolveGitChangeInputs(this.gitService, status, change, comparison);
			if (this.isDisposed) return;
			if (inputs.original && inputs.modified) {
				await this.editorService.openEditor(createDiffEditorInput(inputs.original, inputs.modified, `${inputs.original.label} ↔ ${inputs.modified.label}`), { pinned });
			} else if (inputs.modified) {
				await this.editorService.openEditor(inputs.modified, { pinned });
			} else if (inputs.original) {
				await this.editorService.openEditor(inputs.original, { pinned });
			}
		} catch (error) {
			if (!this.isDisposed) this.statusElement.textContent = gitErrorMessage(error);
		}
	}

	private viewChangesAction(title: string, changes: readonly GitRepositoryChange[], side: GitChangeSide): IAction {
		const label = `View All ${title}`;
		return {
			id: `scm.section.viewAll.${side}.${sectionActionId(title)}`,
			label,
			tooltip: label,
			icon: lxiconsLibrary.codeReview,
			enabled: true,
			checked: undefined,
			run: () => void this.openChanges(title, changes, side),
		};
	}

	private async openChanges(title: string, changes: readonly GitRepositoryChange[], side: GitChangeSide): Promise<void> {
		const status = this.status;
		if (!status) return;
		const comparison: GitChangeFileComparison = side === "index" ? "staged" : "unstaged";
		try {
			const options: OpenScmMultiDiffEditorOptions = { title, comparison, status, changes };
			const result = await this.commandService.executeCommand<OpenScmMultiDiffEditorResult>(OpenScmMultiDiffEditorCommandId, options);
			if (this.isDisposed || this.status !== status) return;
			if (result === "empty") {
				this.statusElement.textContent = `No text changes are available in ${title}.`;
			}
		} catch (error) {
			if (!this.isDisposed) this.statusElement.textContent = gitErrorMessage(error);
		}
	}

	private pathAction(id: string, label: string, action: GitPathAction, paths: readonly string[]): IAction {
		return {
			id,
			label,
			tooltip: label,
			icon: action === "stage" ? lxiconsLibrary.add : action === "unstage" ? lxiconsLibrary.remove : lxiconsLibrary.discard,
			enabled: true,
			checked: undefined,
			run: () => this.requestPathAction(action, paths),
		};
	}

	private renderActionToolbar(container: HTMLElement, actions: readonly IAction[], ariaLabel: string): HTMLDivElement {
		const toolbar = this.renderedChanges.add(new WorkbenchToolBar(container, this.contextMenuProvider, {
			ariaLabel,
			actionViewItemProvider: (action, options) => {
				const item = new ScmActionViewItem(action, () => this.busy, options);
				this.actionViewItems.push(item);
				return item;
			},
		}));
		toolbar.setActions(actions);
		toolbar.element.classList.add("ash-scm-action-toolbar");
		return toolbar.element;
	}

	private renderError(error: unknown, revision: number): void {
		if (this.isDisposed || revision !== this.revision) return;
		this.status = undefined;
		this.unavailable = true;
		this.actionViewItems.length = 0;
		this.renderedChanges.clear();
		this.changesElement.replaceChildren();
		this.statusElement.textContent = gitErrorMessage(error);
		this.updateCommandState();
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.updateCommandState();
	}

	private renderRepositorySelector(): void {
		const repositories = this.gitService.repositories;
		const activeId = this.gitService.activeRepository?.id;
		this.repositorySelector.replaceChildren(...repositories.map(repository => {
			const option = h(this.element.ownerDocument, "option");
			option.value = repository.id;
			option.textContent = repository.path ? `${repository.label} — ${repository.path}` : repository.label;
			option.selected = repository.id === activeId;
			return option;
		}));
		this.repositorySelectorContainer.hidden = repositories.length <= 1;
		this.repositorySelector.disabled = this.busy || repositories.length <= 1;
	}

	private updateCommandState(): void {
		const hasStagedChanges = (this.status?.changes ?? []).some((change) => !change.conflicted && change.indexStatus !== "unmodified");
		this.commitButton.disabled = this.busy || !hasStagedChanges;
		this.commitInput.disabled = this.busy || this.unavailable;
		this.repositorySelector.disabled = this.busy || this.gitService.repositories.length <= 1;
		for (const item of this.actionViewItems) item.setBusy(this.busy);
	}
}

/** SCM-owned projection of repository mutation state onto a standard action button. */
class ScmActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, private readonly isBusy: () => boolean, options: ActionViewItemOptions) {
		super(action, options);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.setBusy(this.isBusy());
	}

	public setBusy(busy: boolean): void {
		this.button.enabled = this.action.enabled && !busy;
	}
}

function changePaths(change: GitRepositoryChange): string[] {
	return change.originalPath ? [change.originalPath, change.path] : [change.path];
}

function isDiscardable(change: GitRepositoryChange): boolean {
	return !change.conflicted && ["modified", "deleted", "typeChanged"].includes(change.worktreeStatus);
}

function sectionActions(title: string, changes: readonly GitRepositoryChange[], side: GitChangeSide): readonly { readonly id: string; readonly label: string; readonly action: GitPathAction; readonly paths: readonly string[] }[] {
	if (side === "index") {
		return [{ id: "scm.section.unstageAll", label: "Unstage All Changes", action: "unstage", paths: uniquePaths(changes.flatMap(changePaths)) }];
	}
	const actions = [];
	const discardable = changes.filter(isDiscardable).map((change) => change.path);
	if (discardable.length > 0) actions.push({ id: "scm.section.discardAll", label: "Discard All Changes", action: "discard" as const, paths: uniquePaths(discardable) });
	actions.push({ id: `scm.section.stageAll.${title === "Merge Changes" ? "merge" : "changes"}`, label: title === "Merge Changes" ? "Stage All Merge Changes" : "Stage All Changes", action: "stage" as const, paths: uniquePaths(changes.flatMap(changePaths)) });
	return actions;
}

function sectionActionId(title: string): string {
	return title === "Merge Changes" ? "merge" : title === "Staged Changes" ? "staged" : "changes";
}

function uniquePaths(paths: readonly string[]): string[] {
	return [...new Set(paths)];
}

function basename(path: string): string {
	return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function dirname(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const separator = normalized.lastIndexOf("/");
	return separator < 0 ? "" : normalized.slice(0, separator);
}

function statusCode(status: GitChangeStatus): string {
	switch (status) {
		case "modified": return "M";
		case "added": return "A";
		case "deleted": return "D";
		case "renamed": return "R";
		case "copied": return "C";
		case "typeChanged": return "T";
		case "unmerged": return "!";
		case "untracked": return "U";
		case "ignored": return "I";
		case "unmodified": return "";
	}
}

function statusLabel(status: GitChangeStatus): string {
	return status.replace(/([A-Z])/g, " $1").toLowerCase();
}

function pathActionLabel(action: GitPathAction): string {
	switch (action) {
		case "stage": return "Staging";
		case "unstage": return "Unstaging";
		case "discard": return "Discarding";
	}
}
