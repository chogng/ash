import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from "../../../../base/browser/ui/contextview/contextview.js";
import { appendIcon } from "../../../../base/browser/ui/icon/icon.js";
import { IconLabel } from "../../../../base/browser/ui/iconlabel/iconlabel.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { MenuWorkbenchToolBar } from "../../../../platform/actions/browser/toolbar.js";
import { MenuId } from "../../../../platform/actions/common/actions.js";
import type { IMenuService } from "../../../../platform/actions/common/menuService.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import type { IHoverService } from "../../../../platform/hover/browser/hoverService.js";
import type { IFileIconThemeService } from "../../../../platform/theme/browser/fileIconThemeService.js";
import type { GitCommitChange, GitCommitChanges, GitCommitSummary, GraphPage, GitHead, GitReference, GitRemoteProvider, IGitService } from "../../../services/git/common/gitService.js";
import type { IEditorService } from "../../../services/editor/common/editorService.js";
import type { IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ViewPane } from "../../../browser/parts/views/viewPane.js";
import { createDiffEditorInput } from "../../codeEditor/browser/diffEditorInput.js";
import { createRows, GraphRowHeight, renderRow, type GraphNodeKind, type GraphRow, type GraphState } from "./scmGraphRenderer.js";
import { GitGraphBusyContext } from "./scmGraphTitleActions.js";
import { gitErrorMessage } from "./scmError.js";

const PageSize = 50;
const LoadAhead = 48;
const Overscan = 8;

type ExpandedCommit =
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly result: GitCommitChanges }
	| { readonly state: "error"; readonly message: string };

/** Paged repository history rendered as a compact commit graph. */
export class ScmGraphViewPane extends ViewPane {
	private readonly gitService: IGitService;
	private readonly busyContext: IContextKey<boolean>;
	private readonly graphElement: HTMLDivElement;
	private readonly hovers = this._register(new DisposableStore());
	private readonly more = this._register(new DisposableStore());
	private page: GraphPage | undefined;
	private head: GitHead | undefined;
	private generation = 0;
	private cursor: string | undefined;
	private loading = false;
	private moreError: string | undefined;
	private rows: readonly GraphRow[] = [];
	private graphState: GraphState = { lanes: [], nextColor: 0 };
	private list: HTMLOListElement | undefined;
	private readonly refs = new Map<string, readonly GitReference[]>();
	private readonly expanded = new Map<string, ExpandedCommit>();
	private graphRepositoryId: string | undefined;
	public get repositoryId(): string | undefined { return this.graphRepositoryId; }

	constructor(container: HTMLElement, options: IViewPaneOptions, gitService: IGitService, menuService: IMenuService, private readonly contextMenuService: IContextMenuService, contextKeyService: IContextKeyService, private readonly hoverService: IHoverService, private readonly editorService: IEditorService, private readonly fileIconThemeService: IFileIconThemeService) {
		super(container, { ...options, headerActionsVisibility: "whenExpanded" });
		this.gitService = gitService;
		this.contentElement.classList.add("ash-scm-secondary-pane");
		this.graphElement = h(container.ownerDocument, "div");
		this.graphElement.className = "ash-scm-graph";
		this.graphElement.setAttribute("role", "status");
		this.graphElement.setAttribute("aria-live", "polite");
		this._register(addDisposableListener(this.graphElement, "scroll", () => {
			this.renderRows();
			if (this.graphElement.scrollTop + this.graphElement.clientHeight >= this.graphElement.scrollHeight - LoadAhead) void this.loadMore();
		}));
		this.contentElement.append(this.graphElement);
		this._register(observeElementSize(this.graphElement, () => this.renderRows()));
		this._register(fileIconThemeService.onDidFileIconThemeChange(() => this.renderRows()));
		this.busyContext = GitGraphBusyContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.busyContext.reset()));
		const toolbar = this._register(new MenuWorkbenchToolBar(
			this.headerActionsElement,
			menuService,
			contextMenuService,
			MenuId.GitGraphTitle,
			{ ariaLabel: "Git graph actions", menuOptions: { arg: this } },
		));
		toolbar.element.classList.add("ash-scm-remote-actions");
		this._register(this.gitService.onDidBecomeReady(() => void this.refresh()));
		void this.refresh();
	}

	public async runTitleOperation(operation?: () => Promise<unknown>): Promise<void> {
		this.busyContext.set(true);
		try {
			await operation?.();
			await this.refresh();
		} finally {
			this.busyContext.set(false);
		}
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const repositoryId = this.gitService.activeRepository?.id;
		this.graphRepositoryId = repositoryId;
		this.page = undefined;
		this.head = undefined;
		this.cursor = undefined;
		this.loading = false;
		this.moreError = undefined;
		this.rows = [];
		this.graphState = { lanes: [], nextColor: 0 };
		this.list = undefined;
		this.refs.clear();
		this.expanded.clear();
		this.hovers.clear();
		this.more.clear();
		this.graphElement.textContent = "Loading commit graph…";
		this.graphElement.setAttribute("aria-busy", "true");
		try {
			const [graph, status] = await Promise.all([
				this.gitService.graph({ limit: PageSize }, repositoryId),
				this.gitService.status(repositoryId),
			]);
			if (this.isDisposed || generation !== this.generation) return;
			this.graphRepositoryId = status.repositoryId;
			this.page = graph;
			this.head = status.head;
			this.cursor = graph.nextCursor;
			this.renderGraph(graph, status.head);
			if (graph.hasMore) void this.loadMore();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			const document = this.graphElement.ownerDocument;
			const message = h(document, "p");
			message.className = "ash-scm-empty";
			message.textContent = gitErrorMessage(error);
			const retry = h(document, "button");
			retry.className = "ash-scm-command";
			retry.type = "button";
			retry.textContent = "Retry";
			retry.setAttribute("aria-label", "Retry loading commit graph");
			this.more.add(addDisposableListener(retry, "click", () => void this.refresh()));
			this.graphElement.replaceChildren(message, retry);
			this.graphElement.setAttribute("aria-busy", "false");
		}
	}

	private renderGraph(graph: GraphPage, head: GitHead): void {
		this.hovers.clear();
		this.more.clear();
		this.rows = [];
		this.graphState = { lanes: [], nextColor: 0 };
		this.refs.clear();
		for (const reference of graph.references) {
			const references = this.refs.get(reference.objectId) ?? [];
			this.refs.set(reference.objectId, [...references, reference]);
		}
		const batch = createRows(graph.commits);
		this.rows = batch.rows;
		this.graphState = batch.state;
		const remotes = this.renderRemotes(graph);
		const children: HTMLElement[] = remotes ? [remotes] : [];
		this.list = undefined;
		if (graph.commits.length === 0) {
			const empty = h(this.graphElement.ownerDocument, "p");
			empty.className = "ash-scm-empty";
			empty.textContent = "No commits yet.";
			children.push(empty);
		} else {
			this.list = h(this.graphElement.ownerDocument, "ol");
			this.list.className = "ash-scm-graph-list";
			this.list.setAttribute("role", "tree");
			children.push(this.list);
		}
		if (graph.hasMore) children.push(this.renderMore());
		this.graphElement.replaceChildren(...children);
		this.renderRows();
		this.graphElement.setAttribute("aria-busy", this.loading ? "true" : "false");
	}

	private renderRows(): void {
		const list = this.list;
		const head = this.head;
		if (!list || !head || this.rows.length === 0) return;
		this.hovers.clear();
		const listTop = offsetTopWithinScrollContainer(list, this.graphElement);
		const viewportTop = Math.max(0, this.graphElement.scrollTop - listTop);
		const viewportHeight = Math.max(GraphRowHeight, this.graphElement.clientHeight);
		const offsets = this.rowOffsets();
		const firstVisible = offsets.findIndex((offset, index) => offset + this.rowHeight(this.rows[index].commit) > viewportTop);
		const start = Math.max(0, (firstVisible < 0 ? this.rows.length - 1 : firstVisible) - Overscan);
		let end = start;
		while (end < this.rows.length && offsets[end] < viewportTop + viewportHeight) end += 1;
		end = Math.min(this.rows.length, Math.max(start + 1, end + Overscan));
		const children: HTMLElement[] = [this.renderSpacer(offsets[start] ?? 0)];
		for (let index = start; index < end; index += 1) {
			const row = this.rows[index];
			children.push(this.renderCommit(row.commit, head, this.refs.get(row.commit.objectId) ?? [], renderRow(this.graphElement.ownerDocument, row, graphNodeKind(row.commit, head), this.rowHeight(row.commit))));
		}
		const totalHeight = offsets.at(-1)! + this.rowHeight(this.rows.at(-1)!.commit);
		children.push(this.renderSpacer(totalHeight - (offsets[end] ?? totalHeight)));
		list.replaceChildren(...children);
	}

	private rowOffsets(): number[] {
		const offsets: number[] = [];
		let offset = 0;
		for (const row of this.rows) {
			offsets.push(offset);
			offset += this.rowHeight(row.commit);
		}
		return offsets;
	}

	private rowHeight(commit: GitCommitSummary): number {
		const expanded = this.expanded.get(commit.objectId);
		if (!expanded) return GraphRowHeight;
		const childRows = expanded.state === "ready" ? Math.max(1, expanded.result.changes.length) : 1;
		return GraphRowHeight * (childRows + 1);
	}

	private renderSpacer(height: number): HTMLLIElement {
		const spacer = h(this.graphElement.ownerDocument, "li");
		spacer.className = "ash-scm-graph-spacer";
		spacer.setAttribute("aria-hidden", "true");
		spacer.style.height = `${height}px`;
		return spacer;
	}

	private renderMore(): HTMLDivElement {
		const container = h(this.graphElement.ownerDocument, "div");
		container.className = "ash-scm-graph-load-more";
		if (this.moreError) {
			const error = h(this.graphElement.ownerDocument, "span");
			error.className = "ash-scm-empty";
			error.textContent = this.moreError;
			container.append(error);
		}
		const button = h(this.graphElement.ownerDocument, "button");
		button.className = "ash-scm-command";
		button.type = "button";
		button.disabled = this.loading;
		button.textContent = this.loading ? "Loading commit history…" : this.moreError ? "Retry" : "Load more commits";
		button.setAttribute("aria-label", this.moreError ? "Retry loading commit history" : "Load more commits");
		this.more.add(addDisposableListener(button, "click", () => void this.loadMore()));
		container.append(button);
		return container;
	}

	private updateMore(): void {
		const current = this.graphElement.querySelector(".ash-scm-graph-load-more");
		if (!this.page?.hasMore) {
			current?.remove();
			this.more.clear();
		} else if (current) {
			this.more.clear();
			current.replaceWith(this.renderMore());
		} else {
			this.graphElement.append(this.renderMore());
		}
		this.graphElement.setAttribute("aria-busy", this.loading ? "true" : "false");
	}

	private async loadMore(): Promise<void> {
		const page = this.page;
		const head = this.head;
		if (!page || !head || !page.hasMore || this.loading) return;

		const generation = this.generation;
		this.loading = true;
		this.moreError = undefined;
		this.updateMore();
		try {
			while (this.page?.hasMore) {
				const current = this.page;
				const next = await this.gitService.graph({ limit: PageSize, ...(this.cursor ? { cursor: this.cursor } : {}) }, this.graphRepositoryId);
				if (this.isDisposed || generation !== this.generation) return;
				const commits = [...current.commits];
				const knownObjectIds = new Set(commits.map((commit) => commit.objectId));
				const additions: GitCommitSummary[] = [];
				for (const commit of next.commits) {
					if (knownObjectIds.has(commit.objectId)) continue;
					knownObjectIds.add(commit.objectId);
					commits.push(commit);
					additions.push(commit);
				}
				const batch = createRows(additions, this.graphState);
				this.rows = [...this.rows, ...batch.rows];
				this.graphState = batch.state;
				this.page = { ...next, commits };
				this.cursor = next.nextCursor;
				this.updateMore();
				this.renderRows();
			}
			this.loading = false;
			this.updateMore();
			this.renderRows();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			this.loading = false;
			this.moreError = gitErrorMessage(error);
			this.updateMore();
		}
	}

	private renderCommit(commit: GitCommitSummary, head: GitHead, references: readonly GitReference[], graph: SVGSVGElement): HTMLLIElement {
		const document = this.graphElement.ownerDocument;
		const item = h(document, "li");
		item.className = "ash-scm-graph-commit";
		const current = headObjectId(head) === commit.objectId;
		const merge = commit.parentObjectIds.length > 1;
		item.classList.toggle("current", current);
		item.classList.toggle("head", current);
		item.classList.toggle("merge", merge);
		item.classList.toggle("commit", !current && !merge);
		item.style.setProperty("--scm-graph-node-x", `${graph.dataset.nodeX ?? 11}px`);
		item.style.setProperty("--scm-graph-content-x", graph.style.width || "22px");
		item.tabIndex = 0;
		item.setAttribute("role", "treeitem");
		item.setAttribute("aria-expanded", String(this.expanded.has(commit.objectId)));
		if (current) item.setAttribute("aria-current", "true");
		this.hovers.add(this.hoverService.setupHover({
			target: item,
			content: () => this.renderCommitHover(commit),
			groupId: "scm.history.items",
			anchorAlignment: AnchorAlignment.Left,
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			anchorPosition: AnchorPosition.Below,
			gap: 8,
		}));
		const details = h(document, "span");
		details.className = "ash-scm-graph-details";
		const subject = h(document, "span");
		subject.className = "ash-scm-graph-subject";
		subject.textContent = commit.subject;
		details.append(subject);
		const visibleReferences = commitReferences(commit, head, references);
		if (visibleReferences.length > 0) details.append(this.renderReferenceLabels(visibleReferences));
		const metadata = h(document, "span");
		metadata.className = "ash-scm-graph-metadata";
		const date = new Date(commit.timestampSeconds * 1_000);
		metadata.textContent = `${commit.objectId.slice(0, 7)} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
		const row = h(document, "div");
		row.className = "ash-scm-graph-row";
		row.append(graph, details, metadata);
		item.append(row);
		const expanded = this.expanded.get(commit.objectId);
		if (expanded) item.append(this.renderCommitChanges(commit, expanded));
		this.hovers.add(addDisposableListener(item, "click", (event) => {
			if ((event.target as Element).closest(".ash-scm-graph-change")) return;
			void this.toggleCommit(commit);
		}));
		this.hovers.add(addDisposableListener(item, "keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void this.toggleCommit(commit);
		}));
		this.hovers.add(addDisposableListener(item, "contextmenu", event => {
			event.preventDefault();
			event.stopPropagation();
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({
					x: event.clientX,
					y: event.clientY,
					targetWindow: event.view ?? undefined,
				}),
				menuId: MenuId.SCMHistoryItemContext,
				menuActionOptions: { arg: commit },
			});
		}));
		return item;
	}

	private renderReferenceLabels(references: readonly GitReference[]): HTMLSpanElement {
		const container = h(this.graphElement.ownerDocument, "span");
		container.className = "ash-scm-graph-label-container";
		container.setAttribute("aria-label", "Git references");
		for (const reference of references) {
			const label = h(this.graphElement.ownerDocument, "span");
			label.className = `ash-scm-graph-label ${reference.current ? "head" : reference.kind === "remoteBranch" ? "remote" : "local"}`;
			label.dataset.icon = reference.kind === "remoteBranch" ? "cloud" : "git-branch";
			appendIcon(reference.kind === "remoteBranch" ? lxiconsLibrary.cloud : lxiconsLibrary.gitBranch, label);
			const text = h(this.graphElement.ownerDocument, "span");
			text.className = "ash-scm-graph-label-description";
			text.textContent = reference.name;
			label.append(text);
			label.title = reference.kind === "remoteBranch" ? `Fetched remote branch ${reference.name}` : `Local branch ${reference.name}`;
			container.append(label);
		}
		return container;
	}

	private renderRemotes(graph: GraphPage): HTMLDivElement | undefined {
		if (graph.remotes.length === 0) return undefined;
		const container = h(this.graphElement.ownerDocument, "div");
		container.className = "ash-scm-graph-remotes";
		container.setAttribute("aria-label", "Git remotes");
		for (const remote of graph.remotes) {
			const label = h(this.graphElement.ownerDocument, "span");
			label.className = "ash-scm-graph-remote";
			label.textContent = remote.identity ? `${remoteLabel(remote.identity.provider)} · ${remote.identity.owner}/${remote.identity.repository} · ${remote.name}` : remote.name;
			label.title = remote.identity ? `${remote.identity.host}/${remote.identity.owner}/${remote.identity.repository}` : `Git remote ${remote.name}`;
			container.append(label);
		}
		return container;
	}

	private renderCommitChanges(commit: GitCommitSummary, expanded: ExpandedCommit): HTMLUListElement {
		const document = this.graphElement.ownerDocument;
		const list = h(document, "ul");
		list.className = "ash-scm-graph-changes";
		if (expanded.state !== "ready" || expanded.result.changes.length === 0) {
			const state = h(document, "li");
			state.className = `ash-scm-graph-change-state ${expanded.state}`;
			state.textContent = expanded.state === "loading" ? "Loading changed files…" : expanded.state === "error" ? expanded.message : "No changed files.";
			list.append(state);
			return list;
		}
		for (const change of expanded.result.changes) {
			const row = h(document, "li");
			const button = h(document, "button");
			button.className = "ash-scm-graph-change";
			button.type = "button";
			button.title = `Open ${change.path} from ${commit.objectId.slice(0, 7)}`;
			const name = change.path.split("/").at(-1) ?? change.path;
			const parentPath = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
			const fileLabel = this.hovers.add(new IconLabel(button, {
				label: name,
				description: parentPath || undefined,
				reserveIconSpace: true,
				renderIcon: (container) => this.fileIconThemeService.renderFileIcon(commitFileUri(commit.objectId, change.path, "modified"), container),
				title: change.path,
			}));
			fileLabel.element.classList.add("ash-scm-graph-change-label");
			fileLabel.element.querySelector(".ash-icon-label-description")?.classList.add("ash-scm-graph-change-description");
			const status = h(document, "span");
			status.className = `ash-scm-graph-change-status ${change.status}`;
			status.textContent = changeStatusLabel(change.status);
			button.append(fileLabel.element, status);
			this.hovers.add(addDisposableListener(button, "click", (event) => {
				event.stopPropagation();
				if (event.detail > 1) return;
				void this.openCommitChange(commit, change, expanded.result, false);
			}));
			this.hovers.add(addDisposableListener(button, "dblclick", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.openCommitChange(commit, change, expanded.result, true);
			}));
			this.hovers.add(addDisposableListener(button, "contextmenu", event => {
				event.preventDefault();
				event.stopPropagation();
				this.contextMenuService.showContextMenu({
					getAnchor: () => ({
						x: event.clientX,
						y: event.clientY,
						targetWindow: event.view ?? undefined,
					}),
					menuId: MenuId.SCMHistoryItemChangeContext,
					menuActionOptions: { args: [commit, change] },
				});
			}));
			row.append(button);
			list.append(row);
		}
		return list;
	}

	private async toggleCommit(commit: GitCommitSummary): Promise<void> {
		if (this.expanded.delete(commit.objectId)) {
			this.renderRows();
			return;
		}
		const generation = this.generation;
		this.expanded.set(commit.objectId, { state: "loading" });
		this.renderRows();
		try {
			const result = await this.gitService.commitChanges(commit.objectId, commit.repositoryId);
			if (this.isDisposed || generation !== this.generation || !this.expanded.has(commit.objectId)) return;
			this.expanded.set(commit.objectId, { state: "ready", result });
		} catch (error) {
			if (this.isDisposed || generation !== this.generation || !this.expanded.has(commit.objectId)) return;
			this.expanded.set(commit.objectId, { state: "error", message: gitErrorMessage(error) });
		}
		this.renderRows();
	}

	private async openCommitChange(commit: GitCommitSummary, change: GitCommitChange, expanded: GitCommitChanges, pinned: boolean): Promise<void> {
		const file = await this.gitService.commitFile(commit.objectId, change.path, commit.repositoryId);
		const name = change.path.split("/").at(-1) ?? change.path;
		const original = file.original.kind === "text" ? {
			resource: commitFileUri(expanded.parentObjectId ?? "root", change.originalPath ?? change.path, "original"),
			label: `${name} (${expanded.parentObjectId?.slice(0, 7) ?? "empty"})`,
			readOnly: true,
			initialText: file.original.text,
		} : undefined;
		const modified = file.modified.kind === "text" ? {
			resource: commitFileUri(commit.objectId, change.path, "modified"),
			label: `${name} (${commit.objectId.slice(0, 7)})`,
			readOnly: true,
			initialText: file.modified.text,
		} : undefined;
		if (original && modified) {
			await this.editorService.openEditor(createDiffEditorInput(original, modified, `${original.label} ↔ ${modified.label}`), { pinned });
		} else if (modified) {
			await this.editorService.openEditor(modified, { pinned });
		} else if (original) {
			await this.editorService.openEditor(original, { pinned });
		}
	}

	private renderCommitHover(commit: GitCommitSummary): HTMLDivElement {
		const document = this.graphElement.ownerDocument;
		const hover = h(document, "div");
		hover.className = "ash-scm-graph-hover";
		const subject = h(document, "div");
		subject.className = "ash-scm-graph-hover-subject";
		subject.textContent = commit.subject;
		const metadata = h(document, "div");
		metadata.className = "ash-scm-graph-hover-metadata";
		metadata.textContent = `${commit.objectId} · ${new Date(commit.timestampSeconds * 1_000).toLocaleString()}`;
		hover.append(subject, metadata);
		return hover;
	}
}

function headObjectId(head: GitHead): string | undefined {
	return head.type === "unborn" ? undefined : head.objectId;
}

function graphNodeKind(commit: GitCommitSummary, head: GitHead): GraphNodeKind {
	if (headObjectId(head) === commit.objectId) return "head";
	return commit.parentObjectIds.length > 1 ? "merge" : "commit";
}

function remoteLabel(provider: GitRemoteProvider): string {
	switch (provider) {
		case "github": return "GitHub";
		case "gitlab": return "GitLab";
		case "bitbucket": return "Bitbucket";
		case "other": return "Remote";
	}
}

function commitReferences(commit: GitCommitSummary, head: GitHead, references: readonly GitReference[]): readonly GitReference[] {
	const result = references.map((reference) => ({ ...reference }));
	if (head.type === "branch" && head.objectId === commit.objectId) {
		const current = result.findIndex((reference) => reference.kind === "localBranch" && reference.name === head.name);
		if (current >= 0) result[current] = { ...result[current], current: true };
		else result.unshift({ name: head.name, objectId: commit.objectId, kind: "localBranch", remoteName: undefined, current: true });
	} else if (head.type === "detached" && head.objectId === commit.objectId) {
		result.unshift({ name: commit.objectId.slice(0, 7), objectId: commit.objectId, kind: "localBranch", remoteName: undefined, current: true });
	}
	return result.sort((left, right) => Number(right.current) - Number(left.current) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

function changeStatusLabel(status: GitCommitChange["status"]): string {
	switch (status) {
		case "modified": return "M";
		case "added": return "A";
		case "deleted": return "D";
		case "renamed": return "R";
		case "copied": return "C";
		case "typeChanged": return "T";
		case "unmerged": return "U";
		case "unmodified": return "";
		case "untracked": return "?";
		case "ignored": return "!";
	}
}

function commitFileUri(objectId: string, path: string, side: "original" | "modified"): URI {
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	return URI.parse(`git-commit:/${encodeURIComponent(objectId)}/${encodedPath}?side=${side}`);
}

function offsetTopWithinScrollContainer(element: HTMLElement, scrollContainer: HTMLElement): number {
	if (element.offsetParent === scrollContainer) return element.offsetTop;
	if (element.offsetParent === scrollContainer.offsetParent) return element.offsetTop - scrollContainer.offsetTop;
	return element.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop;
}
