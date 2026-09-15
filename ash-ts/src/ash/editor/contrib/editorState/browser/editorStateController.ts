import { addDisposableListener } from "../../../../base/browser/dom.js";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { EditorInteractionStateStore } from "../common/editorInteractionState.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type CursorsController } from "../../../common/cursor/cursor.js";
import { type View } from "../../../browser/view.js";

/** Binds browser focus, selection, and scroll events into the common editor-state model. */
export class EditorStateController extends Disposable {
	constructor(private readonly input: HTMLElement, private readonly viewport: View, private readonly selections: CursorsController, private readonly state: EditorInteractionStateStore) {
		super();
		this._register(addDisposableListener(input, "focus", () => state.setFocused(true)));
		this._register(addDisposableListener(input, "blur", () => state.setFocused(false)));
		this._register(selections.onDidChange(change => state.setSelections(change.selections)));
		this._register(viewport.onDidChangeLayout(layout => state.setScrollPosition(layout.layout.scrollPosition.left, layout.layout.scrollPosition.top)));
	}
}

registerEditorContribution({ id: "editor.contrib.editorState", install: context => {
	if (context.kind !== "text") return;
	const state = context.register(new EditorInteractionStateStore(context.model, context.selectionController.getSelections()));
	context.register(new EditorStateController(context.controller.element, context.view, context.selectionController, state));
} });
