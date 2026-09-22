import { addDisposableListener, h, text as createText } from "../../../../../base/browser/dom.js";
import { type FastDomNode } from '../../../../../base/browser/fastDomNode.js';
import { IME } from '../../../../../base/common/ime.js';
import { Disposable, MutableDisposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { AccessibilitySupport } from '../../../../../platform/accessibility/common/accessibility.js';
import { EditorOption, type IComputedEditorOptions } from '../../../../common/config/editorOptions.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type ViewContext } from '../../../../common/viewModel/viewContext.js';
import { type EditContextViewController } from '../editContext.js';
import { clampScreenReaderOffset, createScreenReaderContentState, DEFAULT_SCREEN_READER_PAGE_SIZE, domOffsetAtPoint, domPointAtOffset, modelOffsetAtContentOffset, screenReaderLineOffsetAtModelOffset, type IScreenReaderContent, type ScreenReaderContentLayout, type ScreenReaderContentState } from "./screenReaderUtils.js";

/** Plain-text screen-reader projection used by the native EditContext. */
export class SimpleScreenReaderContent extends Disposable implements IScreenReaderContent {
	protected readonly element: HTMLDivElement;
	private readonly selectionChangeListener = this._register(new MutableDisposable());
	private state: ScreenReaderContentState | undefined;
	private accessibilityPageSize = DEFAULT_SCREEN_READER_PAGE_SIZE;
	private lineHeight = 1;
	private focused = false;
	private ignoreSelectionChangeTime = 0;
	private previousSelectionChangeEventTime = 0;
	private readonly model: TextModel;

	constructor(
		private readonly domNode: FastDomNode<HTMLElement>,
		private readonly context: ViewContext,
		private readonly viewController: EditContextViewController,
	) {
		super();
		const model = context.viewModel.model;
		if (!(model instanceof TextModel)) {
			this.dispose();
			throw new TypeError('Native screen-reader content requires the editor text model implementation');
		}
		this.model = model;
		const host = domNode.domNode;
		this.element = h(host.ownerDocument, "div");
		this.element.className = "stanza-native-screen-reader-content";
		this.element.setAttribute("aria-hidden", "true");
		host.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(addDisposableListener(this.element, "mousedown", event => event.preventDefault()));
	}

	onWillCut(): void {
		this.setIgnoreSelectionChange();
	}

	onWillPaste(): void {
		this.setIgnoreSelectionChange();
	}

	onFocusChange(focused: boolean): void {
		this.focused = focused;
		if (focused) {
			this.selectionChangeListener.value = addDisposableListener(
				this.domNode.domNode.ownerDocument,
				'selectionchange',
				() => this.handleSelectionChange(),
			);
			return;
		}
		this.selectionChangeListener.clear();
		this.clear();
	}

	onConfigurationChanged(options: IComputedEditorOptions): void {
		this.accessibilityPageSize = options.get(EditorOption.accessibilityPageSize);
	}

	updateScreenReaderContent(primarySelection: Selection): void {
		if (!this.focused) {
			this.clear();
			return;
		}
		this.sync(createScreenReaderContentState(this.model, primarySelection, {
			pageSize: this.accessibilityPageSize,
		}));
	}

	updateScrollTop(primarySelection: Selection): void {
		if (!this.state) return;
		this.element.scrollTop = screenReaderLineOffsetAtModelOffset(
			this.state,
			this.model.offsetAt(primarySelection.getPosition()),
		) * this.lineHeight;
	}

	getState(): ScreenReaderContentState | undefined {
		return this.state;
	}

	private sync(state: ScreenReaderContentState): void {
		this.state = state;
		this.renderText(state.text, state);
		this.element.setAttribute("aria-hidden", "false");
		this.setDomSelection(state);
	}

	clear(): void {
		this.state = undefined;
		this.element.replaceChildren();
		this.element.scrollTop = 0;
		this.resetLayout();
		this.element.setAttribute("aria-hidden", "true");
	}

	layout(layout: ScreenReaderContentLayout): void {
		this.element.style.left = `${layout.left}px`;
		this.element.style.top = `${layout.top}px`;
		this.element.style.width = `${layout.width}px`;
		this.element.style.height = `${layout.height}px`;
		this.element.style.lineHeight = `${layout.lineHeight}px`;
		this.lineHeight = layout.lineHeight;
	}

	private readSelection(): { readonly anchorOffset: number; readonly activeOffset: number } | undefined {
		const state = this.state;
		if (!state) return undefined;
		const selection = this.domNode.domNode.ownerDocument.getSelection();
		if (!selection) return undefined;
		const anchorOffset = domOffsetAtPoint(this.element, selection.anchorNode, selection.anchorOffset);
		const activeOffset = domOffsetAtPoint(this.element, selection.focusNode, selection.focusOffset);
		if (anchorOffset === undefined || activeOffset === undefined) return undefined;
		const backward = selection.direction === "backward";
		return {
			anchorOffset: modelOffsetAtContentOffset(state, clampScreenReaderOffset(anchorOffset, state.text.length), backward ? "end" : "start"),
			activeOffset: modelOffsetAtContentOffset(state, clampScreenReaderOffset(activeOffset, state.text.length), backward ? "start" : "end"),
		};
	}

	private setIgnoreSelectionChange(): void {
		this.ignoreSelectionChangeTime = Date.now();
	}

	private shouldIgnoreSelectionChange(now: number): boolean {
		const elapsed = now - this.ignoreSelectionChangeTime;
		this.ignoreSelectionChangeTime = 0;
		return elapsed < 100;
	}

	protected renderText(text: string, _state: ScreenReaderContentState): void {
		if (this.element.textContent === text && this.element.firstChild?.nodeType === 3) return;
		this.element.replaceChildren(createText(this.element.ownerDocument, text));
	}

	protected setDomSelection(state: ScreenReaderContentState): void {
		const selection = this.domNode.domNode.ownerDocument.getSelection();
		const anchor = domPointAtOffset(this.element, state.anchorOffset);
		const active = domPointAtOffset(this.element, state.activeOffset);
		if (!selection || !anchor || !active) return;
		this.setIgnoreSelectionChange();
		selection.setBaseAndExtent(anchor.node, anchor.offset, active.node, active.offset);
	}

	private resetLayout(): void {
		this.element.style.removeProperty("left");
		this.element.style.removeProperty("top");
		this.element.style.removeProperty("width");
		this.element.style.removeProperty("height");
		this.element.style.removeProperty("line-height");
	}

	private handleSelectionChange(): void {
		if (
			!this.state ||
			!this.focused ||
			this.context.configuration.options.get(EditorOption.accessibilitySupport) !== AccessibilitySupport.Enabled ||
			this.viewController.compositionController.composing ||
			!IME.enabled
		) return;
		const now = Date.now();
		if (now - this.previousSelectionChangeEventTime < 5) return;
		this.previousSelectionChangeEventTime = now;
		if (this.shouldIgnoreSelectionChange(now)) return;
		const domSelection = this.readSelection();
		if (!domSelection) return;
		const anchor = this.model.positionAt(domSelection.anchorOffset);
		const active = this.model.positionAt(domSelection.activeOffset);
		const current = this.context.viewModel.getSelections()[0]!;
		if (current.getSelectionStart().equals(anchor) && current.getPosition().equals(active)) return;
		this.viewController.setSelection(Selection.fromPositions(anchor, active));
	}
}
