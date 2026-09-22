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

	constructor(
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		folding: EditorFoldingModel,
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
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.stickyScroll) || event.hasChanged(EditorOption.lineHeight) || event.hasChanged(EditorOption.fontInfo)) {
				this.render();
			}
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
		let offset = 0;
		const scrollTop = this.editor.getScrollTop();
		for (const candidate of candidates) {
			if (starts.length === options.maxLineCount) {
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
		return new StickyScrollWidgetState(starts, ends, offset);
	}

	private revealLine(lineNumber: number): void {
		const position = new Position(lineNumber, 1);
		this.editor.setPosition(position, "stickyScroll");
		this.viewport.revealPosition(position);
		this.editor.focus();
	}

	private render(): void {
		this.widget.setState(this.findScrollWidgetState());
		this.visible.set(this.widget.getCurrentLines().length > 0);
	}
}
