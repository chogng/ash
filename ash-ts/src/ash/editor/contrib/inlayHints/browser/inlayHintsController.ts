import "./media/inlayHints.css";
import { registerTextEditorCapabilityContribution } from "../../../browser/editorExtensions.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { InlayHintsService, type LanguageInlayHint } from "../common/languageInlayHints.js";
import { type View } from "../../../browser/view.js";
import { h } from "../../../../base/browser/dom.js";

/** Projects versioned inlay hints into lightweight editor-local inline nodes. */
export class InlayHintsController extends Disposable {
	private hints: readonly LanguageInlayHint[] = [];
	private request: AbortController | undefined;

	constructor(private readonly viewport: View, private readonly service: InlayHintsService, private readonly languageId: string, private readonly onError: (error: unknown) => void = error => console.error("Stanza inlay hints failed", error)) {
		super();
		this._register(viewport.onDidChangeLayout(() => this.render()));
		this._register(viewport.textModel.onDidChangeContent(() => void this.refresh()));
		this._register(toDisposable(() => this.cancelRequest()));
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		this.cancelRequest();
		const request = this.request = new AbortController();
		const model = this.viewport.textModel;
		try {
			const hints = await this.service.provideInlayHints(this.languageId, Range.fromPositions(new Position((0) + 1, (0) + 1), model.positionAt(model.length)), request.signal);
			if (request.signal.aborted) return;
			this.hints = hints;
			this.render();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private render(): void {
		for (const element of [...this.viewport.domNode.domNode.querySelectorAll<HTMLElement>(".stanza-editor-inlay-hint")]) element.remove();
		const scroll = this.viewport.viewportLayout.scrollPosition;
		for (const hint of this.hints) {
			const element = h(this.viewport.domNode.domNode.ownerDocument, "span");
			element.className = "stanza-editor-inlay-hint";
			element.textContent = typeof hint.label === "string" ? hint.label : hint.label.map(part => part.value).join("");
			const coordinates = this.viewport.getPositionContentCoordinates(hint.position);
			element.style.left = `${coordinates.left - scroll.left + 2}px`;
			element.style.top = `${coordinates.top - scroll.top}px`;
			if (hint.tooltip) element.title = hint.tooltip;
			this.viewport.domNode.domNode.append(element);
		}
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}

registerTextEditorCapabilityContribution({ id: "editor.contrib.inlayHints", install: context => {
	if (context.kind !== "text" || context.options.inlayHints?.enabled === 'off' || context.model.largeFile.tooLargeForTokenization) return;
	const service = context.register(new InlayHintsService(context.model, context.languageFeaturesService.inlayHintsProvider, context.options.input.resource));
	context.register(new InlayHintsController(context.view, service, context.languageId, context.onLanguageError));
} });
