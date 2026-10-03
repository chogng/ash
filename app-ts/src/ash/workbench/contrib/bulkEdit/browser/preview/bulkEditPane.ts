import { MutableDisposable, toDisposable, DisposableStore } from "../../../../../base/common/lifecycle.js";
import { addDisposableListener, h, isHTMLElement } from "../../../../../base/browser/dom.js";
import { type ResourceEdit } from "../../../../../editor/browser/services/bulkEditService.js";
import { ViewPane, type IViewPaneOptions } from "../../../../browser/parts/views/viewPane.js";
import { type BulkEditPreviewEntry, BulkFileOperations } from "./bulkEditPreview.js";
import { localize } from '../../../../../nls.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey, type IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';
import './bulkEdit.css';

interface ActivePreview {
	readonly resolve: (edit: ResourceEdit[] | undefined) => void;
}

/** Selectable preview for an ordered multi-resource workspace edit. */
export class BulkEditPane extends ViewPane {
	public static readonly ID = 'refactorPreview';
	public static readonly ctxHasCategories = new RawContextKey('refactorPreview.hasCategories', false);
	public static readonly ctxGroupByFile = new RawContextKey('refactorPreview.groupByFile', true);
	public static readonly ctxHasCheckedChanges = new RawContextKey('refactorPreview.hasCheckedChanges', false);
	private readonly enabledContext: IContextKey<boolean>;
	private readonly checkedContext: IContextKey<boolean>;
	private readonly categoriesContext: IContextKey<boolean>;
	private readonly groupingContext: IContextKey<boolean>;
	private readonly rowResources = this._register(new DisposableStore());
	private readonly previewButton: HTMLButtonElement;
	private previewId = '';
	private readonly statusElement: HTMLDivElement;
	private readonly listElement: HTMLUListElement;
	private readonly selectAllButton: HTMLButtonElement;
	private readonly applyButton: HTMLButtonElement;
	private readonly cancelButton: HTMLButtonElement;
	private readonly groupButton: HTMLButtonElement;
	private readonly groupButtonControl: Button;
	private model: BulkFileOperations | undefined;
	private readonly modelLifetime = this._register(new MutableDisposable<BulkFileOperations>());
	private inputId = 0;
	private renderedModel: BulkFileOperations | undefined;
	private renderedGrouping: boolean | undefined;
	private readonly conflictListener = this._register(new MutableDisposable());
	private groupsByFile = true;
	private activePreview: ActivePreview | undefined;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IEditorService private readonly editors: IEditorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(container, options);
		const context = this._register(contextKeys.createScoped(this.element));
		this.enabledContext = context.createKey('refactorPreview.enabled', false);
		this.checkedContext = BulkEditPane.ctxHasCheckedChanges.bindTo(context);
		this.categoriesContext = BulkEditPane.ctxHasCategories.bindTo(context);
		this.groupingContext = BulkEditPane.ctxGroupByFile.bindTo(context);
		this.contentElement.classList.add("ash-bulk-edit");
		const document = container.ownerDocument;
		const toolbar = h(document, "div");
		toolbar.className = "ash-bulk-edit-toolbar";
		this.selectAllButton = this.createButton(document, localize('bulkEdit.selectAll', 'Select all'), "ash-bulk-edit-select-all").domNode;
		this.applyButton = this.createButton(document, localize('bulkEdit.applySelected', 'Apply selected'), "ash-bulk-edit-apply").domNode;
		this.cancelButton = this.createButton(document, localize('bulkEdit.cancel', 'Cancel'), "ash-bulk-edit-cancel").domNode;
		this.groupButtonControl = this.createButton(document, localize('bulkEdit.groupByType', 'Group by type'), 'ash-bulk-edit-group');
		this.groupButton = this.groupButtonControl.domNode;
		this.previewButton = this.createButton(document, localize('bulkEdit.openDiff', 'Open changes'), 'ash-bulk-edit-open-diff').domNode;
		toolbar.append(this.selectAllButton, this.groupButton, this.previewButton, this.applyButton, this.cancelButton);
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
		this._register(addDisposableListener(this.previewButton, 'click', () => {
			void this.openPreview().catch(error => { this.statusElement.textContent = getErrorMessage(error); });
		}));
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

	async setInput(edits: ResourceEdit[], signal: AbortSignal): Promise<ResourceEdit[] | undefined> {
		this.assertNotDisposed();
		if (this.activePreview || this.model) { this.discard(); }
		const inputId = ++this.inputId;
		const previousFocus = this.element.ownerDocument.activeElement;
		const model = await this.instantiation.invokeFunction(BulkFileOperations.create, edits, signal);
		if (inputId !== this.inputId || signal.aborted || this.isDisposed) {
			model.dispose();
			return undefined;
		}
		this.modelLifetime.value = model;
		this.model = model;
		this.previewId = generateUuid();
		const listeners = new DisposableStore();
		this.conflictListener.value = listeners;
		listeners.add(model.conflicts.onDidConflict(() => this.render()));
		listeners.add(model.checked.onDidChange(() => this.render()));
		this.render();
		return await new Promise<ResourceEdit[] | undefined>(resolve => {
			const abortListener = addDisposableListener(signal, 'abort', () => this.discard(), { once: true });
			this.activePreview = { resolve: value => {
				abortListener.dispose();
				if (isHTMLElement(previousFocus) && previousFocus.isConnected && !this.element.contains(previousFocus)) { previousFocus.focus(); }
				resolve(value);
			} };
			this.listElement.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
		});
	}

	public discard(): void {
		this.inputId++;
		const active = this.activePreview;
		this.activePreview = undefined;
		active?.resolve(undefined);
		this.conflictListener.clear();
		this.model = undefined;
		this.modelLifetime.clear();
		this.render();
	}

	private createButton(document: Document, label: string, className: string): Button {
		const host = h(document, 'span');
		const button = this._register(new Button(host, { label, presentation: className === 'ash-bulk-edit-apply' ? 'primary' : 'quiet' }));
		button.domNode.classList.add(className);
		return button;
	}

	private selectAll(): void {
		this.model?.selectAll();
	}

	public accept(): void {
		const model = this.model;
		const active = this.activePreview;
		if (!model || !active || !model.canApply || model.conflicts.hasConflicts() || model.checked.checkedCount === 0 || model.hasSelectionDependencyError()) { return; }
		this.activePreview = undefined;
		active.resolve(model.getWorkspaceEdit());
		this.conflictListener.clear();
		this.model = undefined;
		this.modelLifetime.clear();
		this.render();
	}

	private toggleSelection(event: Event): void {
		const element = event.target;
		// Adopted controls can retain the constructor of their original window.
		if (!isHTMLElement(element) || element.tagName !== 'INPUT' || !this.model) { return; }
		const target = element as HTMLInputElement;
		const index = Number(target.dataset.bulkEditIndex);
		this.model.updateChecked(index, target.checked, target.dataset.textEditIndex === undefined ? undefined : Number(target.dataset.textEditIndex));
	}

	private render(): void {
		const model = this.model;
		this.enabledContext.set(model !== undefined);
		this.checkedContext.set(model !== undefined && this.model!.checked.checkedCount > 0 && model.canApply && !model.conflicts?.hasConflicts() && !this.model!.hasSelectionDependencyError());
		this.categoriesContext.set(model !== undefined && new Set(model.entries.map(entry => entry.kind)).size > 1);
		this.groupingContext.set(this.groupsByFile);
		if (!model) {
			this.rowResources.clear();
			this.previewButton.disabled = true;
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
		const selected = model.entries.filter(entry => this.model!.isChecked(entry.index)).length;
		this.statusElement.textContent = errors === 0
			? localize('bulkEdit.ready', '{0} edits ready · {1} selected', model.entries.length, selected)
			: localize('bulkEdit.errors', '{0} edits cannot be applied; resolve the problem before continuing.', errors);
		this.selectAllButton.disabled = model.entries.every(entry => entry.error !== undefined);
		const dependencyError = this.model!.hasSelectionDependencyError();
		if (dependencyError) this.statusElement.textContent = localize('bulkEdit.selectionDependency', 'Selected changes depend on excluded replacements. Select the preceding changes to continue.');
		if (model.conflicts?.hasConflicts()) this.statusElement.textContent = localize('bulkEdit.conflict', 'Files changed during preview. Cancel and run the refactoring again.');
		this.applyButton.disabled = !model.canApply || model.conflicts?.hasConflicts() === true || selected === 0 || dependencyError;
		this.cancelButton.disabled = false;
		this.groupButton.disabled = false;
		this.previewButton.disabled = !model.entries.some(entry => entry.before !== undefined && entry.after !== undefined && !entry.error);
		this.groupButtonControl.label = this.groupsByFile ? localize('bulkEdit.groupByType', 'Group by type') : localize('bulkEdit.groupByFile', 'Group by file');
		if (this.renderedModel !== model || this.renderedGrouping !== this.groupsByFile) {
			if (this.renderedModel !== model) {
				this.rowResources.clear();
			}
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
			checkbox.checked = this.model!.isChecked(index) && (editIndex === undefined || this.model!.selectedTextIndices(index)?.has(Number(editIndex)) === true);
			const entry = model.edit.entries[index];
			checkbox.indeterminate = editIndex === undefined && entry?.kind === 'textDocument' && this.model!.isChecked(index) && this.model!.selectedTextIndices(index)!.size < entry.edits.length;
		}
		for (const content of this.listElement.querySelectorAll<HTMLElement>('pre[data-preview-index]')) {
			const index = Number(content.dataset.previewIndex);
			const entry = model.edit.entries[index];
			const before = model.entries.find(entry => entry.index === index)?.before;
			if (entry?.kind !== 'textDocument' || before === undefined) continue;
			using snapshot = new TextModel(before);
			snapshot.applyEdits(entry.edits.filter((_edit, editIndex) => this.model!.isChecked(index) && this.model!.selectedTextIndices(index)?.has(editIndex)));
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
		checkbox.checked = this.model!.isChecked(entry.index);
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
		if (!entry.error && entry.before !== undefined && entry.after !== undefined) {
			const open = this.rowResources.add(new Button(item, { label: localize('bulkEdit.openDiff', 'Open changes'), size: 'small' }));
			open.domNode.classList.add('ash-bulk-edit-open-diff');
			this.rowResources.add(open.onDidClick(() => {
				void this.openPreview(entry.index).catch(error => { this.statusElement.textContent = getErrorMessage(error); });
			}));
			if (entry.before !== entry.after) {
				item.append(this.renderTextChange(entry.index, entry.before, entry.after));
			}
		}
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

	public toggleGrouping(): void {
		this.groupsByFile = !this.groupsByFile;
		this.render();
	}

	public toggleChecked(): void {
		const element = this.element.ownerDocument.activeElement;
		if (isHTMLElement(element) && element.tagName === 'INPUT' && this.listElement.contains(element)) {
			(element as HTMLInputElement).click();
		}
	}

	private async openPreview(index?: number): Promise<void> {
		const model = this.model;
		if (!model) {
			return;
		}
		const items: MultiDiffEditorInputItem[] = [];
		for (const preview of model.entries) {
			if (index !== undefined && preview.index !== index || preview.error || preview.before === undefined || preview.after === undefined) {
				continue;
			}
			const entry = model.edit.entries[preview.index]!;
			let after = this.model!.isChecked(preview.index) ? preview.after : preview.before;
			if (entry.kind === 'textDocument') {
				using snapshot = new TextModel(preview.before);
				snapshot.applyEdits(entry.edits.filter((_edit, editIndex) => this.model!.isChecked(preview.index) && this.model!.selectedTextIndices(preview.index)?.has(editIndex)));
				after = snapshot.getText();
			}
			const path = `/${this.previewId}/${preview.index}`;
			items.push({
				label: resourceLabel(preview.resource),
				original: { resource: URI.from({ scheme: 'ash-bulkedit-preview', path: `${path}/before` }), initialText: preview.before, readOnly: true },
				modified: { resource: URI.from({ scheme: 'ash-bulkedit-preview', path: `${path}/after/${generateUuid()}` }), initialText: after, readOnly: true },
				goToFile: { resource: preview.secondaryResource ?? preview.resource },
			});
		}
		if (items.length === 0) {
			return;
		}
		const title = localize('bulkEdit.title', 'Refactor Preview');
		const input = createMultiDiffEditorInput(URI.from({ scheme: 'ash-bulkedit-preview', path: `/${this.previewId}/${index ?? 'all'}/${generateUuid()}` }), items, title, { kind: 'snapshot', label: title });
		await this.editors.openEditor(input, { pinned: true });
	}

	public getAccessibleContent(): string {
		if (!this.model) return this.statusElement.textContent ?? '';
		return [this.statusElement.textContent, ...this.model.entries.map(entry => {
			const textEdit = this.model!.edit.entries[entry.index];
			let after = entry.after;
			if (textEdit?.kind === 'textDocument' && entry.before !== undefined) {
				using snapshot = new TextModel(entry.before);
				snapshot.applyEdits(textEdit.edits.filter((_edit, index) => this.model!.isChecked(entry.index) && this.model!.selectedTextIndices(entry.index)?.has(index)));
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

function kindLabel(kind: BulkEditPreviewEntry['kind']): string {
	switch (kind) {
		case 'textDocument': return localize('bulkEdit.textChanges', 'Text changes');
		case 'create': return localize('bulkEdit.create', 'Create file');
		case 'rename': return localize('bulkEdit.rename', 'Rename');
		case 'delete': return localize('bulkEdit.delete', 'Delete');
	}
}
