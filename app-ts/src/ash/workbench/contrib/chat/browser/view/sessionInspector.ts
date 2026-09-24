import { h } from "../../../../../base/browser/dom.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { AgentTreeNode } from "../../../../../sessions/services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagementService.js";
import type { TurnChangeSetSummary } from "../../../../services/chat/common/chatService.js";
import type { ChatPaneModel } from "../pane/chatPaneModel.js";

export interface SessionInspectorDelegate {
	close(): void;
}

/** Chat-owned view of the active Session and the already-subscribed Thread state. */
export class SessionInspector extends Disposable {
	readonly element: HTMLElement;
	private readonly content: HTMLDivElement;
	private readonly binding = this._register(new DisposableStore());
	private readonly editedDrafts = new Map<string, string>();
	private model: ChatPaneModel | undefined;

	constructor(container: HTMLElement, private readonly sessions: ISessionsManagementService, delegate: SessionInspectorDelegate) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, "aside");
		this.element.className = "ash-session-inspector";
		this.element.setAttribute("aria-label", "Session Inspector");
		this.element.tabIndex = -1;

		const header = h(document, "header");
		header.className = "ash-session-inspector-header";
		const title = h(document, "h2");
		title.textContent = "Session Inspector";
		const close = button(document, "Close", "Close Session Inspector");
		close.classList.add("ash-session-inspector-close");
		close.addEventListener("click", () => delegate.close());
		header.append(title, close);

		this.content = h(document, "div");
		this.content.className = "ash-session-inspector-content";
		this.element.append(header, this.content);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.render();
	}

	bind(model: ChatPaneModel | undefined): void {
		if (this.model === model) return;
		this.binding.clear();
		this.model = model;
		this.editedDrafts.clear();
		if (model) this.binding.add(model.onDidChange(() => this.render()));
		this.render();
	}

	focus(): void {
		(this.element.querySelector<HTMLElement>("button, textarea") ?? this.element).focus();
	}

	private render(): void {
		this.content.replaceChildren();
		const model = this.model;
		if (!model?.session || !model.thread) {
			this.content.append(empty(this.content.ownerDocument, "Start a durable chat to inspect its Plan, Threads, Activity, and Changes."));
			return;
		}
		this.content.append(
			this.planSection(model),
			this.threadsSection(model),
			this.activitySection(model),
			this.changesSection(model),
		);
	}

	private planSection(model: ChatPaneModel): HTMLElement {
		const section = inspectorSection(this.content.ownerDocument, "Plan");
		const turn = [...(model.thread?.turns ?? [])].reverse().find((candidate) => candidate.plan);
		if (!turn?.plan) {
			section.body.append(empty(section.body.ownerDocument, "No plan for this Thread."));
			return section.root;
		}
		if (turn.plan.explanation) {
			const explanation = h(section.body.ownerDocument, "p");
			explanation.className = "ash-session-inspector-detail";
			explanation.textContent = turn.plan.explanation;
			section.body.append(explanation);
		}
		const list = h(section.body.ownerDocument, "ol");
		list.className = "ash-session-inspector-plan";
		for (const step of turn.plan.steps) {
			const item = h(list.ownerDocument, "li");
			item.dataset.status = step.status;
			item.textContent = step.step;
			list.append(item);
		}
		section.body.append(list);
		return section.root;
	}

	private threadsSection(model: ChatPaneModel): HTMLElement {
		const section = inspectorSection(this.content.ownerDocument, "Threads");
		const tree = h(section.body.ownerDocument, "div");
		tree.className = "ash-session-inspector-threads";
		tree.setAttribute("role", "tree");
		tree.setAttribute("aria-label", `${model.session!.title} Threads`);
		const nodes = model.session!.agentTree ?? [];
		if (nodes.length === 0) section.body.append(empty(section.body.ownerDocument, "No Thread topology is available."));
		else {
			for (const node of nodes) this.appendThread(tree, model, node, 1);
			section.body.append(tree);
		}
		return section.root;
	}

	private appendThread(tree: HTMLElement, model: ChatPaneModel, node: AgentTreeNode, depth: number): void {
		const title = node.title || (node.origin.type === "root" ? model.session!.title : "Agent Thread");
		const item = button(tree.ownerDocument, title, `Open ${node.title || "Agent Thread"}`);
		item.className = "ash-session-inspector-thread";
		item.setAttribute("role", "treeitem");
		item.setAttribute("aria-level", String(depth));
		item.setAttribute("aria-selected", String(node.threadId === model.threadId));
		item.classList.toggle("selected", node.threadId === model.threadId);
		item.style.paddingInlineStart = `${8 + (depth - 1) * 14}px`;
		item.disabled = node.membershipStatus !== "active";
		item.dataset.status = node.executionStatus;
		item.addEventListener("click", () => this.sessions.selectThread(model.session!.sessionId, node.threadId));
		tree.append(item);
		for (const child of node.children) this.appendThread(tree, model, child, depth + 1);
	}

	private activitySection(model: ChatPaneModel): HTMLElement {
		const section = inspectorSection(this.content.ownerDocument, "Activity");
		const turns = [...(model.thread?.turns ?? [])].reverse().slice(0, 12);
		if (turns.length === 0) section.body.append(empty(section.body.ownerDocument, "No Turn activity yet."));
		for (const turn of turns) {
			const row = h(section.body.ownerDocument, "div");
			row.className = "ash-session-inspector-activity";
			const tools = turn.items.filter((item) => item.type === "toolCall").length;
			row.textContent = `${shortId(turn.turnId)} · ${turn.status}${tools ? ` · ${tools} tools` : ""}`;
			section.body.append(row);
		}
		return section.root;
	}

	private changesSection(model: ChatPaneModel): HTMLElement {
		const section = inspectorSection(this.content.ownerDocument, "Changes");
		const changes = model.changeSets;
		if (changes.length === 0) {
			section.body.append(empty(section.body.ownerDocument, "No changes recorded for this Thread."));
			return section.root;
		}
		for (const changeSet of changes) section.body.append(this.changeCard(model, changeSet));
		const unsettled = changes.some((changeSet) => changeSet.commitState !== "committed" && changeSet.captureState !== "discarded");
		if (unsettled) {
			const discard = button(section.body.ownerDocument, "Discard Thread changes", "Discard every uncommitted change in this Thread");
			discard.classList.add("ash-session-inspector-discard");
			discard.disabled = changes.some((changeSet) => changeSet.captureState === "open");
			discard.addEventListener("click", () => {
				if (!section.body.ownerDocument.defaultView?.confirm("Discard every uncommitted change in this Thread?")) return;
				void model.discardChanges().catch((error) => this.showOperationError(error));
			});
			section.body.append(discard);
		}
		return section.root;
	}

	private changeCard(model: ChatPaneModel, changeSet: TurnChangeSetSummary): HTMLElement {
		const document = this.content.ownerDocument;
		const card = h(document, "article");
		card.className = "ash-session-inspector-change";
		card.dataset.captureState = changeSet.captureState;
		const title = h(document, "h4");
		const state = changeSet.captureState === "open" ? "running" : changeSet.captureState;
		title.textContent = `${shortId(changeSet.turnId)} · ${state} · ${changeSet.statistics.files} files`;
		const repository = h(document, "div");
		repository.className = "ash-session-inspector-detail";
		repository.textContent = changeSet.targetBranch ? `${changeSet.repositoryId} → ${changeSet.targetBranch}` : changeSet.repositoryId;
		card.append(title, repository);
		for (const warning of changeSet.warnings) card.append(status(document, warning, "warning"));
		if (changeSet.dependencies.length) card.append(status(document, `Depends on ${changeSet.dependencies.map(shortId).join(", ")}`, "warning"));
		if (changeSet.externalDependencyPaths.length) card.append(status(document, `External dependencies: ${changeSet.externalDependencyPaths.join(", ")}`, "warning"));
		if (changeSet.conflictPaths.length) card.append(status(document, `Conflicts: ${changeSet.conflictPaths.join(", ")}`, "error"));
		const details = model.turnChangeDetails(changeSet.changeSetId);
		if (details) {
			const files = h(document, "ul");
			files.className = "ash-session-inspector-files";
			for (const file of details.files.slice(0, 20)) {
				const item = h(document, "li");
				item.textContent = `${file.kind} · ${file.path}${file.binary ? " · binary" : ` · +${file.additions} −${file.deletions}`}`;
				files.append(item);
			}
			card.append(files);
		}
		if (changeSet.captureState !== "discarded" && changeSet.commitState !== "committed") card.append(this.messageEditor(model, changeSet));
		if (changeSet.commitState === "committed") card.append(status(document, `Committed ${shortId(changeSet.commitId ?? "")}`, "success"));
		else if (changeSet.commitState === "queued" || changeSet.commitState === "committing") card.append(status(document, changeSet.commitState, "progress"));
		return card;
	}

	private messageEditor(model: ChatPaneModel, changeSet: TurnChangeSetSummary): HTMLElement {
		const document = this.content.ownerDocument;
		const container = h(document, "div");
		container.className = "ash-session-inspector-message";
		const details = model.turnChangeDetails(changeSet.changeSetId);
		const initialDraft = this.editedDrafts.get(changeSet.changeSetId) ?? details?.draftMessage ?? "";
		const textarea = h(document, "textarea");
		textarea.rows = 3;
		textarea.value = initialDraft;
		textarea.readOnly = changeSet.captureState === "open";
		textarea.placeholder = changeSet.messageState === "unconfigured" ? "Enter a commit message" : "Generating commit message…";
		textarea.setAttribute("aria-label", `Commit message for ${shortId(changeSet.turnId)}`);

		const actions = h(document, "div");
		actions.className = "ash-session-inspector-change-actions";
		const save = button(document, "Save", "Save commit message draft");
		const generate = button(document, changeSet.messageState === "failed" ? "Retry" : "Generate", "Generate commit message");
		const commit = button(document, "Commit", "Commit this sealed ChangeSet");
		const updateActions = (): void => {
			const dirty = this.editedDrafts.has(changeSet.changeSetId);
			save.disabled = changeSet.captureState === "open" || !dirty || !textarea.value.trim();
			generate.disabled = changeSet.captureState !== "sealed" || changeSet.messageState === "unconfigured" || changeSet.messageState === "queued" || changeSet.messageState === "generating";
			commit.disabled = changeSet.captureState !== "sealed"
				|| changeSet.dependencies.length > 0
				|| changeSet.externalDependencyPaths.length > 0
				|| !["idle", "conflict", "failed"].includes(changeSet.commitState)
				|| dirty
				|| !textarea.value.trim();
		};
		textarea.addEventListener("input", () => {
			this.editedDrafts.set(changeSet.changeSetId, textarea.value);
			updateActions();
		});
		save.addEventListener("click", () => {
			const message = textarea.value;
			this.editedDrafts.delete(changeSet.changeSetId);
			this.render();
			void model.updateChangeDraft(changeSet, message).catch((error) => {
				this.editedDrafts.set(changeSet.changeSetId, message);
				this.render();
				this.showOperationError(error);
			});
		});
		generate.addEventListener("click", () => void model.generateChangeMessage(changeSet).catch((error) => this.showOperationError(error)));
		commit.addEventListener("click", () => void model.commitChange(changeSet).catch((error) => this.showOperationError(error)));
		updateActions();
		actions.append(save, generate, commit);
		container.append(textarea, actions);
		return container;
	}

	private showOperationError(error: unknown): void {
		const message = error instanceof Error ? error.message : "The ChangeSet operation failed.";
		this.content.prepend(status(this.content.ownerDocument, message, "error"));
	}
}

function inspectorSection(document: Document, titleText: string): { readonly root: HTMLElement; readonly body: HTMLDivElement } {
	const root = h(document, "section");
	root.className = "ash-session-inspector-section";
	const title = h(document, "h3");
	title.textContent = titleText;
	const body = h(document, "div");
	body.className = "ash-session-inspector-section-body";
	root.append(title, body);
	return { root, body };
}

function button(document: Document, text: string, label: string): HTMLButtonElement {
	const element = h(document, "button");
	element.type = "button";
	element.textContent = text;
	element.setAttribute("aria-label", label);
	return element;
}

function empty(document: Document, text: string): HTMLParagraphElement {
	const element = h(document, "p");
	element.className = "ash-session-inspector-empty";
	element.textContent = text;
	return element;
}

function status(document: Document, text: string, kind: "warning" | "error" | "success" | "progress"): HTMLDivElement {
	const element = h(document, "div");
	element.className = `ash-session-inspector-status ${kind}`;
	element.setAttribute("role", kind === "error" ? "alert" : "status");
	element.textContent = text;
	return element;
}

function shortId(value: string): string {
	return value.length <= 12 ? value : value.slice(0, 12);
}
