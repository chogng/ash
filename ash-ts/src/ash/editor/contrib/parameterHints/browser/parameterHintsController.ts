import type { LanguageParameterHints, LanguageParameterHintsContext } from '../../../common/languages.js';
import "./parameterHints.css";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ParameterHintsService } from "../common/languageParameterHints.js";
import { type View } from "../../../browser/view.js";
import { EditorOptions } from '../../../common/config/editorOptions.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';

/** Routes the signature-help shortcut and owns the accessible parameter widget. */
export class ParameterHintsController extends Disposable {
	private readonly element: HTMLDivElement;
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly service: ParameterHintsService,
		private readonly languageId: string,
		private readonly onError: (error: unknown) => void = error => console.error("Stanza parameter hints failed", error),
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('Stanza parameter hints dependencies must share one text model');
		this.element = h(viewport.domNode.domNode.ownerDocument, "div");
		this.element.className = "stanza-editor-parameter-hints";
		this.element.hidden = true;
		this.element.setAttribute("role", "dialog");
		this.element.setAttribute("aria-label", "Parameter hints");
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => {
			this.hide();
			this.element.remove();
		}));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || !event.shiftKey || event.altKey || (!event.ctrlKey && !event.metaKey) || event.key !== " ") return;
			stopEvent(event);
			void this.refresh();
		}));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.key !== "Escape" || this.element.hidden) return;
			stopEvent(event);
			this.hide();
		}));
		this._register(viewport.textModel.onDidChangeContent(change => {
			const inserted = change.changes.length === 1 ? change.changes[0]!.text : "";
			const triggerIndex = Math.max(inserted.lastIndexOf("("), inserted.lastIndexOf(","));
			const trigger = triggerIndex >= 0 ? inserted[triggerIndex] : undefined;
			if (trigger === "(" || trigger === ",") {
				queueMicrotask(() => void this.refresh({ kind: "triggerCharacter", triggerCharacter: trigger }));
			} else if (!this.element.hidden) {
				queueMicrotask(() => void this.refresh({ kind: "contentChange" }));
			} else {
				this.hide();
			}
		}));
		this._register(editor.onDidChangeCursorSelection(() => this.hide()));
		this._register(viewport.onDidChangeLayout(() => this.position()));
	}

	private async refresh(context: LanguageParameterHintsContext = { kind: "invoke" }): Promise<void> {
		if (this.isDisposed) return;
		this.request?.abort();
		const request = this.request = new AbortController();
		try {
			const position = this.editor.getSelections()![0]!.getPosition();
			const hints = await this.service.provideParameterHints(this.languageId, position, context, request.signal);
			if (request.signal.aborted) return;
			if (!hints) { this.hide(); return; }
			this.render(hints);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private render(hints: LanguageParameterHints): void {
		this.element.replaceChildren(...hints.signatures.map((signature, index) => {
			const node = h(this.element.ownerDocument, "div");
			node.className = `stanza-editor-parameter-hints-signature${hints.activeSignature === index ? " active" : ""}`;
			const activeParameter = (hints.activeSignature ?? 0) === index && signature.activeParameter !== undefined ? signature.parameters[signature.activeParameter] : undefined;
			const activeStart = activeParameter ? signature.label.indexOf(activeParameter.label) : -1;
			if (activeParameter && activeStart >= 0) {
				const parameter = h(this.element.ownerDocument, "strong");
				parameter.className = "stanza-editor-parameter-hints-parameter active";
				parameter.textContent = activeParameter.label;
				node.append(signature.label.slice(0, activeStart), parameter, signature.label.slice(activeStart + activeParameter.label.length));
			} else {
				node.textContent = signature.label;
			}
			if (signature.documentation) node.title = signature.documentation;
			return node;
		}));
		this.position();
		this.element.hidden = false;
	}

	private position(): void {
		if (this.element.hidden) return;
		const position = this.editor.getSelections()![0]!.getPosition();
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		const scroll = this.viewport.viewportLayout.scrollPosition;
		this.element.style.left = `${Math.max(8, coordinates.left - scroll.left)}px`;
		this.element.style.top = `${Math.max(8, coordinates.top - scroll.top + coordinates.height + 4)}px`;
	}

	private hide(): void {
		this.request?.abort();
		this.request = undefined;
		this.element.hidden = true;
		this.element.replaceChildren();
	}
}

registerEditorContribution({ id: "editor.contrib.parameterHints", install: context => {
	if (context.kind !== "text" || !EditorOptions.parameterHints.validate(context.options.parameterHints).enabled) return;
	const service = context.register(new ParameterHintsService(
		context.model,
		context.languageFeaturesService.signatureHelpProvider,
		context.options.input.resource,
	));
	return new ParameterHintsController(
		context.controller.element,
		context.editor,
		context.view,
		service,
		context.languageId,
		context.onLanguageError,
	);
} });
