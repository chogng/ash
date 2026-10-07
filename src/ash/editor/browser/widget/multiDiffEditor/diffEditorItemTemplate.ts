import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { formatNlsMessage, localize } from '../../../../nls.js';
import { type CodeEditorViewState } from '../codeEditor/codeEditorWidget.js';
import { DiffEditorWidget } from '../diffEditor/diffEditorWidget.js';
import { type IDocumentDiffItem } from './model.js';
import { type IWorkbenchUIElementFactory } from './workbenchUIElementFactory.js';

export const MULTI_DIFF_HEADER_HEIGHT = 34;
export const MULTI_DIFF_HORIZONTAL_INSET = 18;

export interface DiffEditorItemLayout {
	readonly top: number;
	readonly bodyHeight: number;
	readonly height: number;
}

export interface DiffEditorItemViewState {
	readonly original: CodeEditorViewState | null;
	readonly modified: CodeEditorViewState | null;
}

/** Owns one mounted file header and its optional editable diff editor. */
export class DiffEditorItemTemplate extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly editorHostDomNode: HTMLDivElement;
	private readonly toggleDomNode: HTMLButtonElement;
	private readonly bodyDomNode: HTMLDivElement;
	private readonly incompleteStatusDomNode: HTMLSpanElement;
	private readonly editorSlot = this._register(new MutableDisposable<DiffEditorWidget>());
	private originalState: CodeEditorViewState | null = null;
	private modifiedState: CodeEditorViewState | null = null;
	private editorHeight = 0;

	constructor(
		container: HTMLElement,
		public readonly item: IDocumentDiffItem,
		toggle: () => void,
		activate: () => void,
		workbenchUIElementFactory: IWorkbenchUIElementFactory | undefined,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'stanza-multi-diff-editor-section';
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', item.label);
		const headerDomNode = h(ownerDocument, 'div');
		headerDomNode.className = 'stanza-multi-diff-editor-header';
		this.toggleDomNode = h(ownerDocument, 'button');
		this.toggleDomNode.type = 'button';
		this.toggleDomNode.className = 'stanza-multi-diff-editor-header-toggle';
		this.toggleDomNode.setAttribute('aria-expanded', 'true');
		this.toggleDomNode.setAttribute('aria-keyshortcuts', 'ArrowDown ArrowUp Home End');
		const collapsedIconDomNode = h(ownerDocument, 'span');
		collapsedIconDomNode.className = 'stanza-multi-diff-editor-chevron collapsed-icon';
		appendIcon(Lxicon.chevronRight, collapsedIconDomNode);
		const expandedIconDomNode = h(ownerDocument, 'span');
		expandedIconDomNode.className = 'stanza-multi-diff-editor-chevron expanded-icon';
		appendIcon(Lxicon.chevronDown, expandedIconDomNode);
		const titleDomNode = h(ownerDocument, 'span');
		titleDomNode.className = 'stanza-multi-diff-editor-title';
		titleDomNode.textContent = item.label;
		const labelsDomNode = h(ownerDocument, 'span');
		labelsDomNode.className = 'stanza-multi-diff-editor-labels';
		labelsDomNode.textContent = [item.originalLabel, item.modifiedLabel].filter(label => label !== undefined).join(' ↔ ');
		this.toggleDomNode.append(collapsedIconDomNode, expandedIconDomNode, titleDomNode, labelsDomNode);
		headerDomNode.append(this.toggleDomNode);
		this.incompleteStatusDomNode = h(ownerDocument, 'span');
		this.incompleteStatusDomNode.className = 'stanza-multi-diff-editor-incomplete-status';
		this.incompleteStatusDomNode.setAttribute('role', 'status');
		this.incompleteStatusDomNode.setAttribute('aria-live', 'polite');
		headerDomNode.append(this.incompleteStatusDomNode);
		if (workbenchUIElementFactory) {
			const actionsDomNode = h(ownerDocument, 'div');
			actionsDomNode.className = 'stanza-multi-diff-editor-file-actions';
			headerDomNode.append(actionsDomNode);
			this._register(workbenchUIElementFactory.createItemActions(actionsDomNode, item));
		}
		this.bodyDomNode = h(ownerDocument, 'div');
		this.bodyDomNode.className = 'stanza-multi-diff-editor-body';
		this.editorHostDomNode = h(ownerDocument, 'div');
		this.editorHostDomNode.className = 'stanza-multi-diff-editor-item-editor';
		this.bodyDomNode.append(this.editorHostDomNode);
		this.domNode.append(headerDomNode, this.bodyDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.toggleDomNode, 'click', toggle));
		this._register(addDisposableListener(this.domNode, 'focusin', activate));
		this.updateStatus();
	}

	public get editor(): DiffEditorWidget | undefined {
		return this.editorSlot.value;
	}

	public isHeaderTarget(target: EventTarget | null): boolean {
		return target === this.toggleDomNode;
	}

	public focusHeader(): void {
		this.toggleDomNode.focus({ preventScroll: true });
	}

	public layout(layout: DiffEditorItemLayout, width: number, viewportHeight: number): void {
		this.domNode.style.height = `${layout.height}px`;
		this.domNode.style.top = `${layout.top}px`;
		this.bodyDomNode.style.height = `${layout.bodyHeight}px`;
		this.editorHeight = Math.min(layout.bodyHeight, Math.max(0, viewportHeight - MULTI_DIFF_HEADER_HEIGHT));
		this.editorHostDomNode.style.height = `${this.editorHeight}px`;
		this.layoutEditor(width);
	}

	public layoutEditor(width: number): void {
		this.editor?.layout({ width: Math.max(0, width - MULTI_DIFF_HORIZONTAL_INSET), height: this.editorHeight });
	}

	public mount(editor: DiffEditorWidget): void {
		this.editorSlot.value = editor;
		editor.originalEditor.restoreViewState(this.originalState);
		editor.modifiedEditor.restoreViewState(this.modifiedState);
	}

	public unmount(): void {
		const editor = this.editor;
		if (!editor) return;
		this.originalState = editor.originalEditor.saveViewState();
		this.modifiedState = editor.modifiedEditor.saveViewState();
		this.editorSlot.clear();
	}

	public saveViewState(): DiffEditorItemViewState {
		return {
			original: this.editor?.originalEditor.saveViewState() ?? this.originalState,
			modified: this.editor?.modifiedEditor.saveViewState() ?? this.modifiedState,
		};
	}

	public restoreViewState(original: CodeEditorViewState | null, modified: CodeEditorViewState | null): void {
		this.originalState = original;
		this.modifiedState = modified;
		this.editor?.originalEditor.restoreViewState(original);
		this.editor?.modifiedEditor.restoreViewState(modified);
	}

	public setCollapsed(collapsed: boolean): void {
		this.domNode.classList.toggle('collapsed', collapsed);
		this.toggleDomNode.setAttribute('aria-expanded', String(!collapsed));
		this.updateToggleLabel(collapsed);
		if (collapsed) this.unmount();
	}

	public updateStatus(): void {
		this.updateToggleLabel(this.domNode.classList.contains('collapsed'));
		const model = this.item.model;
		if (this.item.state === 'error') {
			this.incompleteStatusDomNode.textContent = formatNlsMessage(localize('multiDiffEditor.loadError', 'Could not load {0}'), { 0: this.item.label });
			return;
		}
		if (this.item.state === 'loading') {
			this.incompleteStatusDomNode.textContent = localize('multiDiffEditor.loading', 'Loading comparison');
			return;
		}
		if (model?.state.kind === 'error') {
			this.incompleteStatusDomNode.textContent = formatNlsMessage(localize('diffEditor.error', 'Could not compute differences: {0}'), { 0: model.state.error.message });
			return;
		}
		if (model?.state.kind === 'loading') {
			this.incompleteStatusDomNode.textContent = localize('diffEditor.computing', 'Computing differences');
			return;
		}
		this.incompleteStatusDomNode.textContent = model?.state.kind === 'ready' && model.state.quitEarly
			? localize('diffEditor.incompleteShort', 'Diff may be incomplete')
			: '';
	}

	private updateToggleLabel(collapsed: boolean): void {
		this.toggleDomNode.setAttribute('aria-label', formatNlsMessage(collapsed
			? localize('multiDiffEditor.expandItem', 'Expand {0}')
			: localize('multiDiffEditor.collapseItem', 'Collapse {0}'), { 0: this.item.label }));
	}
}
