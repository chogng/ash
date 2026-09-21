import "./media/codeAction.css";
import { addDisposableListener, getActiveElement, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { Range } from "../../../common/core/range.js";
import type { LanguageDiagnostic, LanguageWorkspaceEdit, LanguageCodeAction } from '../../../common/languages.js';
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type View } from "../../../browser/view.js";
import { type CodeActionService } from "../common/languageCodeActions.js";

/** Owns the editor-local code-action picker and routes selected edits through cursor commands. */
export class CodeActionController extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly actionListeners = this._register(new DisposableStore());
	private request: AbortController | undefined;
	private actions: readonly LanguageCodeAction[] = [];
	private actionRange: Range | undefined;
	private actionDiagnostics: readonly LanguageDiagnostic[] = [];

	constructor(private readonly input: HTMLElement, private readonly editor: ICodeEditor, private readonly viewport: View, private readonly service: CodeActionService, private readonly diagnostics: TextDecorationCollection<LanguageDiagnostic>, private readonly languageId: string, private readonly resource: URI, private readonly applyWorkspaceEdit: ((edit: LanguageWorkspaceEdit) => void | Promise<void>) | undefined, private readonly onError: (error: unknown) => void = error => console.error("Editor code action failed", error)) {
		super();
		if (diagnostics.textModel !== viewport.textModel) throw new TypeError("Stanza code action diagnostics and viewport must share one text model");
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "stanza-editor-code-action";
		this.element.hidden = true;
		this.element.setAttribute("role", "menu");
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => {
			this.cancelRequest();
			this.element.remove();
		}));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || event.key !== ".") return;
			stopEvent(event);
			void this.open();
		}));
		this._register(addDisposableListener(this.element, "keydown", event => {
			if (event.key !== "Escape") return;
			stopEvent(event);
			this.close();
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.close()));
	}

	private async open(): Promise<void> {
		this.cancelRequest();
		const request = this.request = new AbortController();
		try {
			const range = this.editor.getSelection();
			if (!range) return;
			const diagnostics = this.diagnostics.decorations.filter(decoration => Range.areIntersectingOrTouching(decoration.range, range)).map(decoration => decoration.metadata);
			const actions = await this.service.provideCodeActions(this.languageId, range.isEmpty() ? Range.fromPositions(range.getStartPosition()) : range, diagnostics, undefined, request.signal);
			if (request.signal.aborted || actions.length === 0) {
				if (!request.signal.aborted) this.viewport.announceAccessibilityStatus("No code actions available.");
				return;
			}
			this.actions = actions;
			this.actionRange = range;
			this.actionDiagnostics = diagnostics;
			this.render();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private render(): void {
		this.actionListeners.clear();
		this.element.replaceChildren(...this.actions.map((action, index) => {
			const button = h(this.element.ownerDocument, "button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			button.textContent = action.disabledReason ? `${action.title} (${action.disabledReason})` : action.title;
			button.disabled = action.disabledReason !== undefined;
			this.actionListeners.add(addDisposableListener(button, "click", () => void this.apply(index)));
			return button;
		}));
		const position = this.editor.getSelection()?.getStartPosition();
		if (!position) return;
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		this.element.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
		this.element.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
		this.element.hidden = false;
		(this.element.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus({ preventScroll: true });
	}

	private async apply(index: number): Promise<void> {
		const action = this.actions[index];
		const range = this.actionRange;
		if (!action || !range) return;
		try {
			const resolved = action.edit ? action : await this.service.resolveCodeAction(this.languageId, range, action, this.actionDiagnostics);
			if (!resolved.edit) {
				this.viewport.announceAccessibilityStatus(`${resolved.title} has no text edit.`);
				this.close();
				return;
			}
			if (this.applyWorkspaceEdit) {
				await this.applyWorkspaceEdit(resolved.edit);
			} else {
				const documentEdit = resolved.edit.entries.find(edit => edit.kind === "textDocument" && edit.resource.toString() === this.resource.toString());
				if (resolved.edit.entries.length !== 1 || !documentEdit || documentEdit.kind !== "textDocument") throw new Error("This editor host cannot apply a multi-resource code action");
				if (documentEdit.edits.length > 0) {
					this.editor.pushUndoStop();
					this.editor.executeEdits('editor.action.codeAction', [...documentEdit.edits]);
					this.editor.pushUndoStop();
				}
			}
			this.close();
		} catch (error) {
			this.onError(error);
		}
	}

	private close(): void {
		const restoreFocus = this.element.contains(getActiveElement(this.element.ownerDocument));
		this.cancelRequest();
		this.actions = [];
		this.actionRange = undefined;
		this.actionDiagnostics = [];
		this.element.hidden = true;
		this.actionListeners.clear();
		this.element.replaceChildren();
		if (restoreFocus) this.input.focus({ preventScroll: true });
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}
