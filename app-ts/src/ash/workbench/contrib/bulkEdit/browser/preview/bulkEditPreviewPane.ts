import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener, h } from "../../../../../base/browser/dom.js";
import { normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../../editor/common/languages.js";
import { ViewPane, type IViewPaneOptions } from "../../../../browser/parts/views/viewPane.js";
import { type BulkEditPreviewEntry, type BulkEditPreviewModel } from "../../common/bulkEdit.js";

/** View identifier used by the Workbench refactoring preview contribution. */
export const BULK_EDIT_VIEW_ID = "ash.bulkEditPreview";

interface ActivePreview {
	readonly resolve: (edit: LanguageWorkspaceEdit | undefined) => void;
}

/** Selectable preview for an ordered multi-resource workspace edit. */
export class BulkEditPreviewPane extends ViewPane {
	private readonly statusElement: HTMLDivElement;
	private readonly listElement: HTMLUListElement;
	private readonly selectAllButton: HTMLButtonElement;
	private readonly applyButton: HTMLButtonElement;
	private readonly cancelButton: HTMLButtonElement;
	private model: BulkEditPreviewModel | undefined;
	private selected = new Set<number>();
	private activePreview: ActivePreview | undefined;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.contentElement.classList.add("ash-bulk-edit");
		const document = container.ownerDocument;
		const toolbar = h(document, "div");
		toolbar.className = "ash-bulk-edit-toolbar";
		this.selectAllButton = this.createButton(document, "Select all", "ash-bulk-edit-select-all");
		this.applyButton = this.createButton(document, "Apply selected", "ash-bulk-edit-apply");
		this.cancelButton = this.createButton(document, "Cancel", "ash-bulk-edit-cancel");
		toolbar.append(this.selectAllButton, this.applyButton, this.cancelButton);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-bulk-edit-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.listElement = h(document, "ul");
		this.listElement.className = "ash-bulk-edit-list";
		this.listElement.setAttribute("aria-label", "Bulk edit preview");
		this.contentElement.append(toolbar, this.statusElement, this.listElement);
		this._register(addDisposableListener(this.selectAllButton, "click", () => this.selectAll()));
		this._register(addDisposableListener(this.applyButton, "click", () => this.accept()));
		this._register(addDisposableListener(this.cancelButton, "click", () => this.cancelInput()));
		this._register(addDisposableListener(this.listElement, "change", event => this.toggleSelection(event)));
		this._register(toDisposable(() => {
			const active = this.activePreview;
			this.activePreview = undefined;
			active?.resolve(undefined);
		}));
		this.render();
	}

	get hasInput(): boolean {
		return this.model !== undefined;
	}

	async setInput(model: BulkEditPreviewModel, signal: AbortSignal): Promise<LanguageWorkspaceEdit | undefined> {
		if (this.activePreview) this.cancelInput();
		this.model = model;
		this.selected = new Set(model.entries.filter(entry => entry.error === undefined).map(entry => entry.index));
		this.render();
		if (signal.aborted) {
			this.cancelInput();
			return undefined;
		}
		return await new Promise<LanguageWorkspaceEdit | undefined>(resolve => {
			const abort = (): void => this.cancelInput();
			signal.addEventListener("abort", abort, { once: true });
			this.activePreview = {
				resolve: value => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
			};
		});
	}

	cancelInput(): void {
		const active = this.activePreview;
		this.activePreview = undefined;
		active?.resolve(undefined);
		this.model = undefined;
		this.selected.clear();
		this.render();
	}

	private createButton(document: Document, label: string, className: string): HTMLButtonElement {
		const button = h(document, "button");
		button.type = "button";
		button.className = className;
		button.textContent = label;
		return button;
	}

	private selectAll(): void {
		if (!this.model) return;
		this.selected = new Set(this.model.entries.filter(entry => entry.error === undefined).map(entry => entry.index));
		this.render();
	}

	private accept(): void {
		const model = this.model;
		const active = this.activePreview;
		if (!model || !active || !model.canApply || this.selected.size === 0) return;
		const entries = model.edit.entries.filter((_entry, index) => this.selected.has(index));
		if (entries.length === 0) return;
		this.activePreview = undefined;
		active.resolve(normalizeLanguageWorkspaceEdit({ entries }));
		this.model = undefined;
		this.selected.clear();
		this.render();
	}

	private toggleSelection(event: Event): void {
		const target = event.target;
		if (!(target instanceof this.element.ownerDocument.defaultView!.HTMLInputElement)) return;
		const index = Number(target.dataset.bulkEditIndex);
		if (!Number.isSafeInteger(index) || !this.model) return;
		const entry = this.model.edit.entries[index];
		if (!entry) return;
		if (target.checked) {
			this.selected.add(index);
			if (entry.kind === "textDocument") {
				for (const candidate of this.model.edit.entries) {
					const candidateIndex = this.model.edit.entries.indexOf(candidate);
					if (candidate.kind !== "textDocument" && isRelatedEntry(entry, candidate) && this.isSelectable(candidateIndex)) this.selected.add(candidateIndex);
				}
			} else {
				for (const candidate of this.model.edit.entries) {
					const candidateIndex = this.model.edit.entries.indexOf(candidate);
					if (isRelatedEntry(entry, candidate) && this.isSelectable(candidateIndex)) this.selected.add(candidateIndex);
				}
			}
		} else {
			for (const candidate of this.model.edit.entries) {
				if (entry.kind !== "textDocument" && isRelatedEntry(entry, candidate)) this.selected.delete(this.model.edit.entries.indexOf(candidate));
			}
			this.selected.delete(index);
		}
		this.render();
	}

	private isSelectable(index: number): boolean {
		const entry = this.model?.entries.find(candidate => candidate.index === index);
		return entry !== undefined && entry.error === undefined;
	}

	private render(): void {
		const model = this.model;
		if (!model) {
			this.statusElement.textContent = "No bulk edit is awaiting approval.";
			this.listElement.replaceChildren();
			this.selectAllButton.disabled = true;
			this.applyButton.disabled = true;
			this.cancelButton.disabled = true;
			return;
		}
		const errors = model.entries.filter(entry => entry.error !== undefined).length;
		const selected = model.entries.filter(entry => this.selected.has(entry.index)).length;
		this.statusElement.textContent = errors === 0
			? `${model.entries.length} ${model.entries.length === 1 ? "edit" : "edits"} ready · ${selected} selected`
			: `${errors} edit${errors === 1 ? "" : "s"} cannot be applied; resolve the problem before continuing.`;
		this.selectAllButton.disabled = model.entries.every(entry => entry.error !== undefined);
		this.applyButton.disabled = !model.canApply || selected === 0;
		this.cancelButton.disabled = false;
		this.listElement.replaceChildren(...model.entries.map(entry => this.renderEntry(entry)));
	}

	private renderEntry(entry: BulkEditPreviewEntry): HTMLLIElement {
		const document = this.element.ownerDocument;
		const item = h(document, "li");
		item.className = `ash-bulk-edit-entry${entry.error ? " has-error" : ""}`;
		const header = h(document, "div");
		header.className = "ash-bulk-edit-entry-header";
		const checkbox = h(document, "input");
		checkbox.type = "checkbox";
		checkbox.checked = this.selected.has(entry.index);
		checkbox.disabled = entry.error !== undefined;
		checkbox.dataset.bulkEditIndex = String(entry.index);
		checkbox.setAttribute("aria-label", `Select ${resourceLabel(entry.resource)}`);
		const kind = h(document, "span");
		kind.className = "ash-bulk-edit-kind";
		kind.textContent = entry.kind;
		const resource = h(document, "span");
		resource.className = "ash-bulk-edit-resource";
		resource.textContent = entry.secondaryResource ? `${resourceLabel(entry.resource)} → ${resourceLabel(entry.secondaryResource)}` : resourceLabel(entry.resource);
		header.append(checkbox, kind, resource);
		const detail = h(document, "div");
		detail.className = "ash-bulk-edit-detail";
		detail.textContent = entry.error ?? entry.detail;
		item.append(header, detail);
		if (!entry.error && entry.before !== undefined && entry.after !== undefined && entry.before !== entry.after) item.append(this.renderTextChange(entry.before, entry.after));
		return item;
	}

	private renderTextChange(before: string, after: string): HTMLElement {
		const document = this.element.ownerDocument;
		const details = h(document, "details");
		details.className = "ash-bulk-edit-text-change";
		const summary = h(document, "summary");
		summary.textContent = "Show text change";
		const content = h(document, "pre");
		content.textContent = `- ${clipText(before)}\n+ ${clipText(after)}`;
		details.append(summary, content);
		return details;
	}
}

function resourceLabel(resource: { readonly path: string }): string {
	const path = decodeURIComponent(resource.path).replaceAll("\\", "/");
	return path.split("/").filter(Boolean).pop() ?? path;
}

function clipText(value: string): string {
	const limit = 1_600;
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function isRelatedEntry(first: LanguageWorkspaceEditEntry, second: LanguageWorkspaceEditEntry): boolean {
	const firstResources = entryResources(first);
	const secondResources = entryResources(second);
	return firstResources.some(resource => secondResources.includes(resource));
}

function entryResources(entry: LanguageWorkspaceEditEntry): readonly string[] {
	return entry.kind === "rename" ? [entry.source.toString(), entry.target.toString()] : [entry.resource.toString()];
}
