import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import { EditorLineWrapping } from "../../../common/config/editorOptions.js";
import { type View } from "../../../browser/view.js";

/** Owns one viewport's transient word-wrap toggle and Alt+Z shortcut. */
export class WordWrapController extends Disposable {
	constructor(
		input: HTMLElement,
		private readonly viewport: View,
	) {
		super();
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
	}

	public toggle(): void {
		const enabled = this.viewport.lineWrapping !== EditorLineWrapping.On;
		this.viewport.setLineWrapping(enabled ? EditorLineWrapping.On : EditorLineWrapping.Off);
		this.viewport.announceAccessibilityStatus(enabled
			? localize("wordWrap.enabled", "Word wrap on")
			: localize("wordWrap.disabled", "Word wrap off"));
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "z") return;
		stopEvent(event);
		this.toggle();
	}
}

registerEditorContribution({ id: "editor.contrib.wordWrap", install: context => {
	if (context.kind !== "text") return;
	return new WordWrapController(context.controller.element, context.view);
} });
