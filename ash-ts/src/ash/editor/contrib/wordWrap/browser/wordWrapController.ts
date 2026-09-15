import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { registerTextEditorCapabilityContribution } from "../../../browser/editorExtensions.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { EditorLineWrapping } from "../../../common/config/editorOptions.js";
import { type View } from "../../../browser/view.js";

/** Owns the transient Alt+Z word-wrap toggle for one Stanza viewport. */
export class WordWrapController extends Disposable {
	constructor(
		input: HTMLElement,
		private readonly viewport: View,
	) {
		super();
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "z") return;
		stopEvent(event);
		this.viewport.setLineWrapping(this.viewport.lineWrapping === EditorLineWrapping.On
			? EditorLineWrapping.Off
			: EditorLineWrapping.On);
	}
}

registerTextEditorCapabilityContribution({ id: "editor.contrib.wordWrap", install: context => {
	if (context.kind !== "text") return;
	context.register(new WordWrapController(context.controller.element, context.view));
} });
