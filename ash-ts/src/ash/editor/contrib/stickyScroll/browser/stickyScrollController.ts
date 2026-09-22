import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Position } from "../../../common/core/position.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { EditorOption } from "../../../common/config/editorOptions.js";
import { type View } from "../../../browser/view.js";
import { type EditorFoldingModel } from "../../folding/browser/foldingModel.js";
import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { EditorContextKeys } from "../../../common/editorContextKeys.js";
import { StickyLineCandidateProvider, type IStickyLineCandidateProvider } from "./stickyScrollProvider.js";
import { StickyScrollWidget, StickyScrollWidgetState } from "./stickyScrollWidget.js";
import { StickyRange } from "./stickyScrollElement.js";

/** Coordinates scope headers with the editor's existing layout and selection. */
export class StickyScrollController extends Disposable {
	public static readonly ID = "store.contrib.stickyScrollController";
	private readonly widget: StickyScrollWidget;
	private readonly candidateProvider: StickyLineCandidateProvider;
	private readonly visible: IContextKey<boolean>;
	private hoveredLine: number | null = null;
	private previewLine: number | null = null;
	private changingFold = false;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly folding: EditorFoldingModel,
		onError: (error: unknown) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		if (folding.model !== viewport.textModel) {
			throw new TypeError("Stanza sticky scroll dependencies must share a text model");
		}
		this.candidateProvider = this._register(instantiationService.createInstance(StickyLineCandidateProvider, editor, folding, onError));
		this.widget = this._register(new StickyScrollWidget(editor, viewport.textModel));
		const element = this.widget.getDomNode();
		viewport.domNode.domNode.append(element);
		const focused = EditorContextKeys.stickyScrollFocused.bindTo(contextKeyService);
		this.visible = EditorContextKeys.stickyScrollVisible.bindTo(contextKeyService);
		this._register(toDisposable(() => {
			focused.reset();
			this.visible.reset();
		}));
		this._register(addDisposableListener(element, "focusin", () => focused.set(true)));
		this._register(addDisposableListener(element, "focusout", () => focused.set(this.isFocused())));
		this._register(addDisposableListener(element, "pointerdown", event => {
			if (event.button === 0) {
				stopEvent(event);
			}
		}));
		this._register(addDisposableListener(element, "mousedown", event => {
			if (event.button === 0) {
				stopEvent(event);
			}
		}));
		this._register(addDisposableListener(element, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			let command: string;
			switch (event.key) {
				case "ArrowDown":
					command = "editor.action.selectNextStickyScrollLine";
					break;
				case "ArrowUp":
					command = "editor.action.selectPreviousStickyScrollLine";
					break;
				case "Enter":
					if (this.widget.isInFoldingIconDomNode(event.target as HTMLElement)) {
						return;
					}
					command = "editor.action.goToFocusedStickyScrollLine";
					break;
				case "Escape":
					command = "editor.action.selectEditor";
					break;
				default:
					return;
			}
			stopEvent(event);
			this.editor.invokeWithinContext(accessor => CommandsRegistry.getCommand(command)!(accessor));
		}));
		this._register(viewport.onDidChangeLayout(() => this.render()));
		this._register(this.candidateProvider.onDidChangeStickyScroll(() => this.render()));
		this._register(folding.onDidChange(() => this.render()));
		this._register(viewport.textModel.tokenization.renderedTokens.onDidChange(() => this.render()));
		this._register(viewport.textModel.onDidChangeOptions(() => this.render()));
		this._register(editor.onDidChangeCursorPosition(() => this.render()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.stickyScroll) || event.hasChanged(EditorOption.lineHeight)
				|| event.hasChanged(EditorOption.fontInfo) || event.hasChanged(EditorOption.lineNumbers)
				|| event.hasChanged(EditorOption.showFoldingControls) || event.hasChanged(EditorOption.folding)) {
				this.render();
			}
		}));
		this._register(addDisposableListener(element, "pointermove", event => {
			const index = this.widget.getLineIndexFromChildDomNode(event.target as HTMLElement);
			this.hoveredLine = index === null ? null : this.widget.getCurrentLines()[index]!;
			this.preview(event.shiftKey);
		}));
		this._register(addDisposableListener(element, "pointerleave", () => {
			this.hoveredLine = null;
			this.preview(false);
		}));
		const window = element.ownerDocument.defaultView!;
		this._register(addDisposableListener(window, "keydown", event => {
			if (event.key === "Shift") {
				this.preview(true);
			}
		}));
		this._register(addDisposableListener(window, "keyup", event => {
			if (event.key === "Shift") {
				this.preview(false);
			}
		}));
		this._register(addDisposableListener(window, "blur", () => {
			this.hoveredLine = null;
			this.preview(false);
		}));
		this._register(addDisposableListener(element, "click", event => {
			if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) {
				return;
			}
			const index = this.widget.getLineIndexFromChildDomNode(event.target as HTMLElement);
			if (index === null) {
				return;
			}
			const state = this.findScrollWidgetState();
			if (this.widget.isInFoldingIconDomNode(event.target as HTMLElement)) {
				stopEvent(event);
				// Hidden areas and scroll change together; retain the focused row until its anchor is settled.
				this.changingFold = true;
				try {
					const line = state.startLineNumbers[index]!;
					this.folding.toggleAtLine(line - 1);
					this.editor.setScrollTop(this.editor.getTopForLineNumber(line) - index * this.editor.getOption(EditorOption.lineHeight) + 1);
				} finally {
					this.changingFold = false;
					this.render();
				}
				return;
			}
			this.revealLine(event.shiftKey ? state.endLineNumbers[index]! : state.startLineNumbers[index]!);
		}));
	}

	public static get(editor: ICodeEditor): StickyScrollController | null {
		return editor.getContribution<StickyScrollController>(StickyScrollController.ID);
	}

	public get stickyScrollCandidateProvider(): IStickyLineCandidateProvider {
		return this.candidateProvider;
	}

	public isFocused(): boolean {
		const element = this.widget.getDomNode();
		return element.contains(element.ownerDocument.activeElement);
	}

	public focus(): void {
		this.widget.focusLineWithIndex(this.widget.getCurrentLines().length - 1);
	}

	public focusNext(): void {
		const element = this.widget.getDomNode();
		const index = this.widget.getLineIndexFromChildDomNode(element.ownerDocument.activeElement as HTMLElement);
		if (index !== null) {
			this.widget.focusLineWithIndex(index + 1);
		}
	}

	public focusPrevious(): void {
		const element = this.widget.getDomNode();
		const index = this.widget.getLineIndexFromChildDomNode(element.ownerDocument.activeElement as HTMLElement);
		if (index !== null) {
			this.widget.focusLineWithIndex(index - 1);
		}
	}

	public selectEditor(): void {
		this.editor.focus();
	}

	public goToFocused(): void {
		const element = this.widget.getDomNode();
		const index = this.widget.getLineIndexFromChildDomNode(element.ownerDocument.activeElement as HTMLElement);
		if (index !== null) {
			this.revealLine(this.widget.getCurrentLines()[index]!);
		}
	}

	public findScrollWidgetState(): StickyScrollWidgetState {
		const options = this.editor.getOption(EditorOption.stickyScroll);
		if (!options.enabled || this.candidateProvider.getVersionId() !== this.viewport.textModel.getVersionId()) {
			return StickyScrollWidgetState.Empty;
		}
		const ranges = this.editor.getVisibleRanges();
		if (ranges.length === 0) {
			return StickyScrollWidgetState.Empty;
		}
		const candidates = this.candidateProvider.getCandidateStickyLinesIntersecting(new StickyRange(ranges[0]!.startLineNumber, ranges.at(-1)!.endLineNumber));
		const starts: number[] = [];
		const ends: number[] = [];
		const heightLimit = Math.round(this.editor.getLayoutInfo().height / (4 * this.editor.getOption(EditorOption.lineHeight)));
		const lineLimit = Math.min(options.maxLineCount, heightLimit);
		let offset = 0;
		const scrollTop = this.editor.getScrollTop();
		for (const candidate of candidates) {
			if (starts.length === lineLimit) {
				break;
			}
			const slotTop = starts.length * candidate.height;
			const end = this.editor.getBottomForLineNumber(candidate.endLineNumber) - scrollTop;
			if (this.editor.getTopForLineNumber(candidate.startLineNumber) - scrollTop >= slotTop || end <= slotTop) {
				continue;
			}
			starts.push(candidate.startLineNumber);
			ends.push(candidate.endLineNumber);
			offset = Math.min(0, end - slotTop - candidate.height);
			if (offset < 0) {
				break;
			}
		}
		const previewIndex = this.previewLine === null ? -1 : starts.indexOf(this.previewLine);
		return new StickyScrollWidgetState(starts, ends, offset, previewIndex < 0 ? null : previewIndex);
	}

	private preview(enabled: boolean): void {
		const line = enabled ? this.hoveredLine : null;
		if (this.previewLine !== line) {
			this.previewLine = line;
			this.render();
		}
	}

	private revealLine(lineNumber: number): void {
		const position = new Position(lineNumber, 1);
		this.editor.setPosition(position, "stickyScroll");
		this.viewport.revealPosition(position);
		this.editor.focus();
	}

	private render(): void {
		if (this.changingFold) {
			return;
		}
		const state = this.findScrollWidgetState();
		if (this.hoveredLine !== null && !state.startLineNumbers.includes(this.hoveredLine)) {
			this.hoveredLine = null;
			this.previewLine = null;
		}
		this.widget.setState(state, this.folding);
		this.visible.set(this.widget.getCurrentLines().length > 0);
	}
}
