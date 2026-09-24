import "./media/gotoLineWidget.css";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { operatingSystem, OperatingSystem } from "../../../../base/common/platform.js";
import { parseStanzaGotoLocation, type GotoLocationParseResult } from "../common/gotoLocation.js";
import { Selection } from "../../../common/core/selection.js";
import { type View } from "../../../browser/view.js";
import { type EditorScrollPosition, type IViewModel } from '../../../common/viewModel.js';
import { localize } from '../../../../nls.js';

export interface GotoLineControllerOptions {
	readonly operatingSystem?: OperatingSystem;
}

/** Owns Stanza's local Go to Line/Column dialog and platform G shortcut. */
export class GotoLineController extends Disposable {
	readonly element: HTMLDivElement;
	readonly input: HTMLInputElement;
	private readonly status: HTMLSpanElement;
	private initialScrollPosition: EditorScrollPosition | undefined;
	private inputMode: 'line' | 'offset' = 'line';

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly viewport: View,
		private readonly viewModel: IViewModel,
		options: GotoLineControllerOptions = {},
	) {
		super();
		this.targetOperatingSystem = options.operatingSystem ?? operatingSystem;
		if (viewport.textModel !== viewModel.model) {
			this.dispose();
			throw new TypeError("Stanza Go to Line dependencies must share one text model");
		}
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "stanza-editor-goto-line-widget";
		this.element.hidden = true;
		this.element.setAttribute("role", "dialog");
		this.element.setAttribute("aria-label", "Go to Line or Column");
		this.input = h(ownerDocument, "input");
		this.input.className = "stanza-editor-goto-line-input";
		this.input.type = "text";
		this.input.placeholder = "Line[:Column]";
		this.input.setAttribute("aria-label", "Line number and optional column");
		this.input.autocomplete = "off";
		this.input.spellcheck = false;
		this.status = h(ownerDocument, "span");
		this.status.className = "stanza-editor-goto-line-status";
		this.status.setAttribute("aria-live", "polite");
		this.element.append(this.input, this.status);
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(addDisposableListener(editorInput, "keydown", event => this.handleEditorKeydown(event)));
		this._register(addDisposableListener(this.element, "keydown", event => this.handleWidgetKeydown(event)));
		this._register(addDisposableListener(this.input, "input", () => this.preview()));
		this._register(viewport.onDidChangeLayout(() => this.position()));
		this._register(viewport.textModel.onDidChangeContent(() => {
			if (this.visible) this.preview();
		}));
	}

	private readonly targetOperatingSystem: OperatingSystem;

	get visible(): boolean {
		return !this.element.hidden;
	}

	open(mode: 'line' | 'offset' = 'line'): void {
		if (!this.visible) this.initialScrollPosition = this.viewport.viewportLayout.scrollPosition;
		this.inputMode = mode;
		this.element.hidden = false;
		this.element.classList.add("visible");
		const current = this.viewModel.getSelections()[0]!.getPosition();
		this.input.value = mode === 'offset'
			? String(this.viewport.textModel.offsetAt(current) + 1)
			: `${current.lineNumber}:${current.column}`;
		this.element.setAttribute('aria-label', mode === 'offset'
			? localize('gotoOffset.dialog', 'Go to Offset')
			: localize('gotoLine.dialog', 'Go to Line or Column'));
		this.input.setAttribute('aria-label', mode === 'offset'
			? localize('gotoOffset.input', 'Character offset')
			: localize('gotoLine.input', 'Line number and optional column'));
		this.input.placeholder = mode === 'offset'
			? localize('gotoOffset.placeholder', 'Offset')
			: localize('gotoLine.placeholder', 'Line[:Column]');
		this.position();
		this.preview();
		this.input.focus({ preventScroll: true });
		this.input.select();
	}

	close(): void {
		if (!this.visible) return;
		this.element.hidden = true;
		this.element.classList.remove("visible");
		const initial = this.initialScrollPosition;
		this.initialScrollPosition = undefined;
		if (initial) this.viewport.scrollTo(initial);
		this.editorInput.focus({ preventScroll: true });
	}

	private handleEditorKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		if (!isStanzaGotoLineChord(event, this.targetOperatingSystem)) return;
		stopEvent(event);
		this.open();
	}

	private handleWidgetKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.key === "Escape") {
			stopEvent(event);
			this.close();
			return;
		}
		if (event.target !== this.input || event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;
		const result = this.readResult();
		if (result.kind !== "location") return;
		stopEvent(event);
		this.viewModel.setSelections(this.inputMode === 'offset' ? 'editor.action.gotoOffset' : 'editor.action.gotoLine', [Selection.fromPositions(result.location.position)]);
		this.viewport.revealPosition(result.location.position);
		this.initialScrollPosition = undefined;
		this.close();
	}

	private preview(): void {
		const result = this.readResult();
		this.status.textContent = result.message;
		this.input.classList.toggle("invalid", result.kind === "invalid");
		this.input.setAttribute("aria-invalid", String(result.kind === "invalid"));
		if (result.kind === "location") this.viewport.revealPosition(result.location.position);
	}

	private readResult(): GotoLocationParseResult {
		return parseStanzaGotoLocation(this.viewport.textModel, this.inputMode === 'offset' ? `::${this.input.value}` : this.input.value);
	}

	private position(): void {
		if (!this.visible) return;
		const layout = this.viewport.viewportLayout;
		const width = Math.max(0, Math.min(340, layout.viewportSize.width - 24));
		this.element.style.width = `${width}px`;
		this.element.style.left = `${layout.scrollPosition.left + Math.max(0, layout.viewportSize.width - width - 12)}px`;
		this.element.style.top = `${layout.scrollPosition.top + 6}px`;
	}
}

registerEditorContribution({
	id: "editor.contrib.quickAccess",
	install: context => {
		if (context.kind !== "text") return;
		return new GotoLineController(context.controller.element, context.view, context.viewModel);
	},
});

/** Identifies Ctrl+G on Windows/Linux and Command+G on macOS. */
export function isStanzaGotoLineChord(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, targetOperatingSystem: OperatingSystem): boolean {
	if (event.shiftKey || event.altKey || event.key.toLowerCase() !== "g") return false;
	return targetOperatingSystem === OperatingSystem.Macintosh
		? event.metaKey && !event.ctrlKey
		: event.ctrlKey && !event.metaKey;
}
