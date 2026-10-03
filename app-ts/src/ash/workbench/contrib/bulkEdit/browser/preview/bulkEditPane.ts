import { MutableDisposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener, h, isHTMLElement } from "../../../../../base/browser/dom.js";
import { type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../../editor/common/languages.js";
import { ViewPane, type IViewPaneOptions } from "../../../../browser/parts/views/viewPane.js";
import { type BulkEditPreviewEntry, type BulkEditPreviewModel } from "./bulkEditPreview.js";
import { localize } from '../../../../../nls.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { normalizeTextLineEndings } from '../../../../../editor/common/core/textChange.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import './bulkEdit.css';

interface ActivePreview {
	readonly resolve: (edit: LanguageWorkspaceEdit | undefined) => void;
}

/** Selectable preview for an ordered multi-resource workspace edit. */
export class BulkEditPane extends ViewPane {
	public static readonly ID = 'refactorPreview';
	private readonly statusElement: HTMLDivElement;
	private readonly listElement: HTMLUListElement;
	private readonly selectAllButton: HTMLButtonElement;
	private readonly applyButton: HTMLButtonElement;
	private readonly cancelButton: HTMLButtonElement;
	private readonly groupButton: HTMLButtonElement;
	private model: BulkEditPreviewModel | undefined;
	private renderedModel: BulkEditPreviewModel | undefined;
	private renderedGrouping: boolean | undefined;
	private selected = new Set<number>();
	private readonly selectedText = new Map<number, Set<number>>();
	private readonly conflictListener = this._register(new MutableDisposable());
	private groupsByFile = true;
	private activePreview: ActivePreview | undefined;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(container, options);
		this.contentElement.classList.add("ash-bulk-edit");
		const document = container.ownerDocument;
		const toolbar = h(document, "div");
		toolbar.className = "ash-bulk-edit-toolbar";
		this.selectAllButton = this.createButton(document, localize('bulkEdit.selectAll', 'Select all'), "ash-bulk-edit-select-all");
		this.applyButton = this.createButton(document, localize('bulkEdit.applySelected', 'Apply selected'), "ash-bulk-edit-apply");
		this.cancelButton = this.createButton(document, localize('bulkEdit.cancel', 'Cancel'), "ash-bulk-edit-cancel");
		this.groupButton = this.createButton(document, localize('bulkEdit.groupByType', 'Group by type'), 'ash-bulk-edit-group');
		toolbar.append(this.selectAllButton, this.groupButton, this.applyButton, this.cancelButton);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-bulk-edit-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.listElement = h(document, "ul");
		this.listElement.className = "ash-bulk-edit-list";
		this.listElement.setAttribute("aria-label", localize('bulkEdit.previewLabel', 'Bulk edit preview'));
		this.contentElement.append(toolbar, this.statusElement, this.listElement);
		this._register(addDisposableListener(this.selectAllButton, "click", () => this.selectAll()));
		this._register(addDisposableListener(this.applyButton, "click", () => this.accept()));
		this._register(addDisposableListener(this.cancelButton, "click", () => this.discard()));
		this._register(addDisposableListener(this.groupButton, 'click', () => this.groupsByFile ? this.groupByType() : this.groupByFile()));
		this._register(addDisposableListener(this.listElement, "change", event => this.toggleSelection(event)));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.discard();
			} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				this.accept();
			}
		}));
		this._register(configuration.onDidChangeConfiguration(() => this.updateAccessibilityHint()));
		this._register(toDisposable(() => {
			const active = this.activePreview;
			this.activePreview = undefined;
			active?.resolve(undefined);
		}));
		this.render();
		this.updateAccessibilityHint();
	}

	get hasInput(): boolean {
		return this.model !== undefined;
	}

	async setInput(model: BulkEditPreviewModel, signal: AbortSignal): Promise<LanguageWorkspaceEdit | undefined> {
		this.assertNotDisposed();
		if (this.activePreview) this.discard();
		const previousFocus = this.element.ownerDocument.activeElement;
		this.model = model;
		this.selected = new Set(model.entries.filter(entry => entry.error === undefined).map(entry => entry.index));
		this.selectedText.clear();
		model.edit.entries.forEach((entry, index) => {
			if (entry.kind === 'textDocument') this.selectedText.set(index, new Set(entry.edits.map((_edit, editIndex) => editIndex)));
		});
		this.conflictListener.value = model.conflicts?.onDidConflict(() => this.render());
		this.render();
		if (signal.aborted) {
			this.discard();
			return undefined;
		}
		return await new Promise<LanguageWorkspaceEdit | undefined>(resolve => {
			const abortListener = addDisposableListener(signal, 'abort', () => this.discard(), { once: true });
			this.activePreview = {
				resolve: value => {
					abortListener.dispose();
					if (isHTMLElement(previousFocus) && previousFocus.isConnected && !this.element.contains(previousFocus)) previousFocus.focus();
					resolve(value);
				},
			};
			this.listElement.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
		});
	}

	public discard(): void {
		const active = this.activePreview;
		this.activePreview = undefined;
		active?.resolve(undefined);
		this.model = undefined;
		this.selected.clear();
		this.selectedText.clear();
		this.conflictListener.clear();
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
		this.model.edit.entries.forEach((entry, index) => {
			if (entry.kind === 'textDocument') this.selectedText.set(index, new Set(entry.edits.map((_edit, editIndex) => editIndex)));
		});
		this.render();
	}

	public accept(): void {
		const model = this.model;
		const active = this.activePreview;
		if (!model || !active || !model.canApply || model.conflicts?.hasConflicts() || this.selected.size === 0 || this.hasSelectionDependencyError()) return;
		const entries = model.edit.entries.flatMap<LanguageWorkspaceEditEntry>((entry, index) => {
			if (!this.selected.has(index)) return [];
			if (entry.kind !== 'textDocument') return [entry];
			const edits = entry.edits.filter((_edit, editIndex) => this.selectedText.get(index)?.has(editIndex));
			return edits.length > 0 ? [{ ...entry, edits }] : [];
		});
		if (entries.length === 0) return;
		this.activePreview = undefined;
		active.resolve({ entries });
		this.model = undefined;
		this.selected.clear();
		this.selectedText.clear();
		this.conflictListener.clear();
		this.render();
	}

	private toggleSelection(event: Event): void {
		const element = event.target;
		// Registered windows can adopt controls created in the main window's realm.
		if (!isHTMLElement(element) || element.tagName !== 'INPUT') return;
		const target = element as HTMLInputElement;
		const index = Number(target.dataset.bulkEditIndex);
		if (!Number.isSafeInteger(index) || !this.model) return;
		const entry = this.model.edit.entries[index];
		if (!entry) return;
		const editIndex = target.dataset.textEditIndex;
		if (entry.kind === 'textDocument') {
			const selected = this.selectedText.get(index)!;
			if (editIndex !== undefined) {
				if (target.checked) selected.add(Number(editIndex));
				else selected.delete(Number(editIndex));
				target.checked = selected.size > 0;
			} else {
				this.selectedText.set(index, new Set(target.checked ? entry.edits.map((_edit, editIndex) => editIndex) : []));
			}
		}
		if (target.checked) {
			this.selected.add(index);
			const resources = relatedResources(entry, this.model.edit.entries);
			this.model.edit.entries.forEach((candidate, candidateIndex) => {
				if ((entry.kind !== 'textDocument' || candidate.kind !== 'textDocument') && entryResources(candidate).some(resource => resources.has(resource)) && this.isSelectable(candidateIndex)) this.selected.add(candidateIndex);
			});
		} else {
			const resources = relatedResources(entry, this.model.edit.entries);
			this.model.edit.entries.forEach((candidate, candidateIndex) => {
				if (entry.kind !== 'textDocument' && entryResources(candidate).some(resource => resources.has(resource))) this.selected.delete(candidateIndex);
			});
			this.selected.delete(index);
		}
		this.render();
	}

	private isSelectable(index: number): boolean {
		const entry = this.model?.entries.find(candidate => candidate.index === index);
		return entry !== undefined && entry.error === undefined;
	}

	private hasSelectionDependencyError(): boolean {
		const contents = new Map<string, string>();
		const model = this.model!;
		// Ordered document steps use the preceding step's resulting snapshot. Excluding
		// an earlier replacement must not make a later step appear ready to apply.
		for (const preview of model.entries) {
			const entry = model.edit.entries[preview.index]!;
			if (entry.kind !== 'textDocument') {
				if (this.selected.has(preview.index)) {
					for (const resource of entryResources(entry)) contents.delete(resource);
				}
				continue;
			}
			if (preview.before === undefined) continue;
			const key = entry.resource.toString();
			const before = contents.get(key) ?? preview.before;
			contents.set(key, before);
			if (!this.selected.has(preview.index)) continue;
			if (normalizeTextLineEndings(before) !== normalizeTextLineEndings(preview.before)) return true;
			using snapshot = new TextModel(before);
			snapshot.applyEdits(entry.edits.filter((_edit, index) => this.selectedText.get(preview.index)!.has(index)));
			contents.set(key, snapshot.getText());
		}
		return false;
	}

	private render(): void {
		const model = this.model;
		if (!model) {
			this.statusElement.textContent = localize('bulkEdit.empty', 'No bulk edit is awaiting approval.');
			this.listElement.replaceChildren();
			this.renderedModel = undefined;
			this.selectAllButton.disabled = true;
			this.applyButton.disabled = true;
			this.cancelButton.disabled = true;
			this.groupButton.disabled = true;
			return;
		}
		const errors = model.entries.filter(entry => entry.error !== undefined).length;
		const selected = model.entries.filter(entry => this.selected.has(entry.index)).length;
		this.statusElement.textContent = errors === 0
			? localize('bulkEdit.ready', '{0} edits ready · {1} selected', model.entries.length, selected)
			: localize('bulkEdit.errors', '{0} edits cannot be applied; resolve the problem before continuing.', errors);
		this.selectAllButton.disabled = model.entries.every(entry => entry.error !== undefined);
		const dependencyError = this.hasSelectionDependencyError();
		if (dependencyError) this.statusElement.textContent = localize('bulkEdit.selectionDependency', 'Selected changes depend on excluded replacements. Select the preceding changes to continue.');
		if (model.conflicts?.hasConflicts()) this.statusElement.textContent = localize('bulkEdit.conflict', 'Files changed during preview. Cancel and run the refactoring again.');
		this.applyButton.disabled = !model.canApply || model.conflicts?.hasConflicts() === true || selected === 0 || dependencyError;
		this.cancelButton.disabled = false;
		this.groupButton.disabled = false;
		this.groupButton.textContent = this.groupsByFile ? localize('bulkEdit.groupByType', 'Group by type') : localize('bulkEdit.groupByFile', 'Group by file');
		if (this.renderedModel !== model || this.renderedGrouping !== this.groupsByFile) {
			const previousFocus = this.element.ownerDocument.activeElement;
			const existingEntries = this.renderedModel === model
				? new Map([...this.listElement.querySelectorAll<HTMLLIElement>('.ash-bulk-edit-entry')].map(item => [Number(item.dataset.bulkEditEntryIndex), item]))
				: new Map<number, HTMLLIElement>();
			this.renderedModel = model;
			this.renderedGrouping = this.groupsByFile;
			const groups = new Map<string, HTMLLIElement>();
			for (const entry of model.entries) {
				const key = this.groupsByFile ? entry.resource.toString() : entry.kind;
				let group = groups.get(key);
				if (!group) {
					group = h(this.element.ownerDocument, 'li');
					group.className = 'ash-bulk-edit-group';
					const label = h(this.element.ownerDocument, 'div');
					label.className = 'ash-bulk-edit-group-label';
					label.textContent = this.groupsByFile ? resourceLabel(entry.resource) : kindLabel(entry.kind);
					const list = h(this.element.ownerDocument, 'ul');
					group.append(label, list);
					groups.set(key, group);
				}
				group.lastElementChild!.append(existingEntries.get(entry.index) ?? this.renderEntry(entry));
			}
			this.listElement.replaceChildren(...groups.values());
			if (isHTMLElement(previousFocus) && this.listElement.contains(previousFocus)) previousFocus.focus();
		}
		for (const checkbox of this.listElement.querySelectorAll<HTMLInputElement>('input[data-bulk-edit-index]')) {
			const index = Number(checkbox.dataset.bulkEditIndex);
			const editIndex = checkbox.dataset.textEditIndex;
			checkbox.checked = this.selected.has(index) && (editIndex === undefined || this.selectedText.get(index)?.has(Number(editIndex)) === true);
			const entry = model.edit.entries[index];
			checkbox.indeterminate = editIndex === undefined && entry?.kind === 'textDocument' && this.selected.has(index) && this.selectedText.get(index)!.size < entry.edits.length;
		}
		for (const content of this.listElement.querySelectorAll<HTMLElement>('pre[data-preview-index]')) {
			const index = Number(content.dataset.previewIndex);
			const entry = model.edit.entries[index];
			const before = model.entries.find(entry => entry.index === index)?.before;
			if (entry?.kind !== 'textDocument' || before === undefined) continue;
			using snapshot = new TextModel(before);
			snapshot.applyEdits(entry.edits.filter((_edit, editIndex) => this.selected.has(index) && this.selectedText.get(index)?.has(editIndex)));
			content.textContent = `- ${clipText(before)}\n+ ${clipText(snapshot.getText())}`;
		}
		this.updateAccessibilityHint();
	}

	private renderEntry(entry: BulkEditPreviewEntry): HTMLLIElement {
		const document = this.element.ownerDocument;
		const item = h(document, "li");
		item.className = `ash-bulk-edit-entry${entry.error ? " has-error" : ""}`;
		item.dataset.bulkEditEntryIndex = String(entry.index);
		const header = h(document, "div");
		header.className = "ash-bulk-edit-entry-header";
		const checkbox = h(document, "input");
		checkbox.type = "checkbox";
		checkbox.checked = this.selected.has(entry.index);
		checkbox.disabled = entry.error !== undefined;
		checkbox.dataset.bulkEditIndex = String(entry.index);
		checkbox.setAttribute("aria-label", localize('bulkEdit.selectResource', 'Select {0}', resourceLabel(entry.resource)));
		const kind = h(document, "span");
		kind.className = "ash-bulk-edit-kind";
		kind.textContent = kindLabel(entry.kind);
		const resource = h(document, "span");
		resource.className = "ash-bulk-edit-resource";
		resource.textContent = entry.secondaryResource ? `${resourceLabel(entry.resource)} → ${resourceLabel(entry.secondaryResource)}` : resourceLabel(entry.resource);
		resource.title = entry.secondaryResource ? `${entry.resource.toString()} → ${entry.secondaryResource.toString()}` : entry.resource.toString();
		header.append(checkbox, kind, resource);
		const detail = h(document, "div");
		detail.className = "ash-bulk-edit-detail";
		detail.textContent = entry.error ?? entry.detail;
		item.append(header, detail);
		const edit = this.model!.edit.entries[entry.index];
		if (edit?.kind === 'textDocument' && edit.edits.length > 1 && !entry.error) {
			const replacements = h(document, 'div');
			replacements.className = 'ash-bulk-edit-replacements';
			edit.edits.forEach((textEdit, index) => {
				const label = h(document, 'label');
				const checkbox = h(document, 'input');
				checkbox.type = 'checkbox';
				checkbox.dataset.bulkEditIndex = String(entry.index);
				checkbox.dataset.textEditIndex = String(index);
				label.append(checkbox, localize('bulkEdit.replacement', 'Line {0}, column {1}: {2}', textEdit.range.startLineNumber, textEdit.range.startColumn, textEdit.text));
				replacements.append(label);
			});
			item.append(replacements);
		}
		if (!entry.error && entry.before !== undefined && entry.after !== undefined && entry.before !== entry.after) item.append(this.renderTextChange(entry.index, entry.before, entry.after));
		return item;
	}

	private renderTextChange(index: number, before: string, after: string): HTMLElement {
		const document = this.element.ownerDocument;
		const details = h(document, "details");
		details.className = "ash-bulk-edit-text-change";
		const summary = h(document, "summary");
		summary.textContent = localize('bulkEdit.showTextChange', 'Show text change');
		const content = h(document, "pre");
		content.dataset.previewIndex = String(index);
		content.textContent = `- ${clipText(before)}\n+ ${clipText(after)}`;
		details.append(summary, content);
		return details;
	}

	public groupByFile(): void {
		this.groupsByFile = true;
		this.render();
	}

	public groupByType(): void {
		this.groupsByFile = false;
		this.render();
	}

	public getAccessibleContent(): string {
		if (!this.model) return this.statusElement.textContent ?? '';
		return [this.statusElement.textContent, ...this.model.entries.map(entry => {
			const textEdit = this.model!.edit.entries[entry.index];
			let after = entry.after;
			if (textEdit?.kind === 'textDocument' && entry.before !== undefined) {
				using snapshot = new TextModel(entry.before);
				snapshot.applyEdits(textEdit.edits.filter((_edit, index) => this.selected.has(entry.index) && this.selectedText.get(entry.index)?.has(index)));
				after = snapshot.getText();
			}
			return [entry.resource.toString(), entry.secondaryResource?.toString(), entry.error ?? entry.detail, entry.before, after].filter(value => value !== undefined).join('\n');
		})].join('\n\n');
	}

	private updateAccessibilityHint(): void {
		const hint = this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.BulkEditPreview) !== false
			? localize('bulkEdit.helpHint', 'Press Alt+F1 for refactor preview help. Press Alt+F2 to read all changes.') : undefined;
		for (const element of [this.contentElement, ...this.contentElement.querySelectorAll<HTMLElement>('button, input, summary')]) {
			if (hint) element.setAttribute('aria-description', hint);
			else element.removeAttribute('aria-description');
		}
	}
}

function resourceLabel(resource: { readonly path: string }): string {
	const path = resource.path.replaceAll("\\", "/");
	return path.split("/").filter(Boolean).pop() ?? path;
}

function clipText(value: string): string {
	const limit = 1_600;
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function relatedResources(entry: LanguageWorkspaceEditEntry, entries: readonly LanguageWorkspaceEditEntry[]): Set<string> {
	const resources = new Set(entryResources(entry));
	let previousSize: number;
	do {
		previousSize = resources.size;
		for (const candidate of entries) {
			if (candidate.kind === 'rename' && entryResources(candidate).some(resource => resources.has(resource))) {
				for (const resource of entryResources(candidate)) resources.add(resource);
			}
		}
	} while (resources.size !== previousSize);
	return resources;
}

function kindLabel(kind: BulkEditPreviewEntry['kind']): string {
	switch (kind) {
		case 'textDocument': return localize('bulkEdit.textChanges', 'Text changes');
		case 'create': return localize('bulkEdit.create', 'Create file');
		case 'rename': return localize('bulkEdit.rename', 'Rename');
		case 'delete': return localize('bulkEdit.delete', 'Delete');
	}
}

function entryResources(entry: LanguageWorkspaceEditEntry): readonly string[] {
	return entry.kind === "rename" ? [entry.source.toString(), entry.target.toString()] : [entry.resource.toString()];
}
