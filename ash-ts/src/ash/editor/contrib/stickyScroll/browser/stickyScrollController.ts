import "./stickyScroll.css";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Position } from "../../../common/core/position.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { EditorOption } from "../../../common/config/editorOptions.js";
import { type View } from "../../../browser/view.js";
import { type EditorFoldingModel } from "../../folding/browser/foldingModel.js";
import { buildStickyScrollEntries } from "../common/stickyScrollModel.js";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";

/** Projects folding ancestors above the viewport as an accessible sticky header stack. */
export class StickyScrollController extends Disposable {
	private readonly element: HTMLDivElement;

	constructor(private readonly editor: ICodeEditor, private readonly viewport: View, private readonly folding: EditorFoldingModel) {
		super();
		if (folding.model !== viewport.textModel) throw new TypeError("Stanza sticky scroll dependencies must share a text model");
		this.element = h(viewport.domNode.domNode.ownerDocument, "div");
		this.element.className = "stanza-editor-sticky-scroll";
		this.element.setAttribute("aria-label", "Sticky section headers");
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(viewport.onDidChangeLayout(() => this.render()));
		this._register(folding.onDidChange(() => this.render()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.stickyScroll)) this.render();
		}));
		this._register(addDisposableListener(this.element, "click", event => {
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".stanza-editor-sticky-scroll-item");
			if (!button || button.parentElement !== this.element) return;
			this.viewport.revealPosition(new Position(Number(button.dataset.lineNumber), 1));
		}));
		this.render();
	}

	private render(): void {
		const visual = this.viewport.getVisualLineProjection();
		const firstVisualLine = this.viewport.viewportLayout.visibleLines.startLineIndex;
		const first = visual.lineAt(firstVisualLine);
		const options = this.editor.getOption(EditorOption.stickyScroll);
		const entries = first && options.enabled
			? buildStickyScrollEntries(this.viewport.textModel, first.logicalLineIndex, this.folding.regions, options.maxLineCount)
			: [];
		const scroll = this.viewport.viewportLayout.scrollPosition;
		this.element.style.transform = `translate(${scroll.left}px, ${scroll.top}px)`;
		const focused = this.element.ownerDocument.activeElement;
		const hadFocus = focused instanceof this.element.ownerDocument.defaultView!.HTMLElement && this.element.contains(focused);
		const buttons = new Map(Array.from(this.element.children, child => {
			const button = child as HTMLButtonElement;
			return [button.dataset.lineId, button] as const;
		}));
		for (const [index, entry] of entries.entries()) {
			const lineId = String(this.viewport.textModel.getLineId(entry.lineIndex));
			let button = buttons.get(lineId);
			if (!button) {
				button = h(this.element.ownerDocument, "button");
				button.type = "button";
				button.className = "stanza-editor-sticky-scroll-item";
				button.dataset.lineId = lineId;
			}
			buttons.delete(lineId);
			button.dataset.lineNumber = String(entry.lineIndex + 1);
			button.style.paddingLeft = `${8 + entry.depth * 12}px`;
			const label = entry.label || `Line ${entry.lineIndex + 1}`;
			if (button.textContent !== label) button.textContent = label;
			button.title = `Reveal line ${entry.lineIndex + 1}`;
			const current = this.element.children.item(index);
			if (current !== button) this.element.insertBefore(button, current);
		}
		for (const button of buttons.values()) button.remove();
		this.element.hidden = entries.length === 0;
		if (hadFocus) {
			if (this.element.contains(focused)) (focused as HTMLElement).focus({ preventScroll: true });
			else this.editor.focus();
		}
	}
}
