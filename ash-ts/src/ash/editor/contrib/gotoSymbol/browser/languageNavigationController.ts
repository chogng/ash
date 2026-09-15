import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EmbeddedCodeEditorWidget } from '../../../browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Selection } from "../../../common/core/selection.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorPeekViewWidget } from "../../peekView/browser/editorPeekViewWidget.js";
import { type LanguageNavigationService } from "../common/languageNavigation.js";
import { type LanguageLocation } from "../../../common/languages.js";

export type LanguageNavigationKind = "definition" | "declaration" | "implementation" | "typeDefinition" | "references";

/** Owns keyboard navigation and the multi-result Peek surface for one text editor. */
export class LanguageNavigationController extends Disposable {
	private readonly peek = this._register(new DisposableStore());
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly service: LanguageNavigationService,
		private readonly resource: URI,
		private readonly languageId: string,
		private readonly openLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Language navigation dependencies must share one text model");
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
		this._register(viewport.textModel.onDidChangeContent(() => this.closePeek()));
		this._register(toDisposable(() => this.cancelRequest()));
	}

	navigate(kind: LanguageNavigationKind, options: { readonly peek?: boolean; readonly includeDeclaration?: boolean } = {}): Promise<void> {
		return this.requestLocations(kind, options);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph") || event.key !== "F12") return;
		stopEvent(event);
		if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
			void this.requestLocations("typeDefinition");
		} else if (event.ctrlKey || event.metaKey) {
			void this.requestLocations("implementation");
		} else if (event.shiftKey) {
			void this.requestLocations("references", { peek: true, includeDeclaration: true });
		} else {
			void this.requestLocations("definition", { peek: event.altKey });
		}
	}

	private async requestLocations(kind: LanguageNavigationKind, options: { readonly peek?: boolean; readonly includeDeclaration?: boolean } = {}): Promise<void> {
		this.cancelRequest();
		const request = this.request = new AbortController();
		const position = this.editor.getSelections()![0]!.getPosition();
		try {
			const locations = await this.provide(kind, position, options.includeDeclaration ?? true, request.signal);
			if (request.signal.aborted) return;
			if (locations.length === 0) {
				this.viewport.announceAccessibilityStatus(`No ${navigationLabel(kind)} found.`);
				return;
			}
			if (options.peek || locations.length > 1) {
				this.showPeek(kind, position, locations);
				return;
			}
			await this.open(locations[0]!);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private provide(kind: LanguageNavigationKind, position: Position, includeDeclaration: boolean, signal: AbortSignal): Promise<readonly LanguageLocation[]> {
		switch (kind) {
			case "definition": return this.service.provideDefinition(this.languageId, position, signal);
			case "declaration": return this.service.provideDeclaration(this.languageId, position, signal);
			case "implementation": return this.service.provideImplementation(this.languageId, position, signal);
			case "typeDefinition": return this.service.provideTypeDefinition(this.languageId, position, signal);
			case "references": return this.service.provideReferences(this.languageId, position, includeDeclaration, signal);
		}
	}

	private showPeek(kind: LanguageNavigationKind, anchor: Position, locations: readonly LanguageLocation[]): void {
		this.closePeek();
		const widget = this.peek.add(new EditorPeekViewWidget(this.editor, anchor, `${locations.length} ${navigationLabel(kind)}${locations.length === 1 ? "" : "s"}`));
		const list = h(widget.element.ownerDocument, "div");
		list.className = "stanza-editor-language-locations";
		list.setAttribute("role", "listbox");
		for (const location of locations) {
			const button = h(widget.element.ownerDocument, "button");
			button.type = "button";
			button.setAttribute("role", "option");
			button.className = "stanza-editor-language-location";
			const selection = location.selectionRange ?? location.range;
			button.textContent = `${resourceLabel(location.resource)}:${selection.startLineNumber}:${selection.startColumn}`;
			this.peek.add(addDisposableListener(button, "click", () => void this.open(location)));
			list.append(button);
		}
		const body = h(widget.element.ownerDocument, 'div');
		body.append(list);
		const sameResource = locations.find(location => location.resource.toString() === this.resource.toString());
		const model = this.editor.getModel();
		if (sameResource && model) {
			const previewHost = h(widget.element.ownerDocument, 'div');
			previewHost.className = 'stanza-editor-language-preview';
			body.append(previewHost);
			const preview = this.peek.add(this.instantiationService.createInstance(EmbeddedCodeEditorWidget,
				previewHost,
				{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false },
				{ container: previewHost, model, input: { resource: model.uri, readOnly: true }, languageId: model.getLanguageId(), presentation: 'embedded', ariaLabel: 'Reference preview' },
				this.editor,
			));
			const range = sameResource.selectionRange ?? sameResource.range;
			preview.setSelection(range);
			preview.revealRange(range);
		}
		widget.setBody(body);
		widget.show();
		(list.firstElementChild as HTMLButtonElement | null)?.focus({ preventScroll: true });
		this.peek.add(addDisposableListener(widget.element, "keydown", event => {
			if (event.key !== "Escape") return;
			stopEvent(event);
			this.closePeek();
			this.input.focus({ preventScroll: true });
		}));
		this.viewport.announceAccessibilityStatus(`${locations.length} ${navigationLabel(kind)}${locations.length === 1 ? "" : "s"} found.`);
	}

	private async open(location: LanguageLocation): Promise<void> {
		this.closePeek();
		const range = location.selectionRange ?? location.range;
		if (location.resource.toString() === this.resource.toString()) {
			this.editor.setSelections([
				Selection.fromPositions(range.getStartPosition(), range.getEndPosition()),
			], 'editor.action.goToLocation');
			this.viewport.revealPosition(range.getStartPosition());
			this.input.focus({ preventScroll: true });
			return;
		}
		if (!this.openLocation) {
			this.viewport.announceAccessibilityStatus("This editor host cannot open the target resource.");
			return;
		}
		await this.openLocation(location);
	}

	private closePeek(): void {
		this.peek.clear();
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}

function navigationLabel(kind: LanguageNavigationKind): string {
	switch (kind) {
		case "typeDefinition": return "type definition";
		default: return kind;
	}
}

function resourceLabel(resource: URI): string {
	const path = decodeURIComponent(resource.path).replace(/\/+$/, "");
	return path.slice(path.lastIndexOf("/") + 1) || resource.toString();
}
