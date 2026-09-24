import type { EditorInput } from "./editorInput.js";
import { EditorTabsControl, type EditorTabDescriptor } from "./editorTabsControl.js";

/** Keeps title actions available while omitting editor tabs entirely. */
export class NoEditorTabsControl extends EditorTabsControl {
	constructor(container: HTMLElement) {
		super(container);
		this.domNode.classList.add("ash-no-editor-tabs-control");
		this.domNode.hidden = true;
	}

	setEditors(_editors: readonly EditorTabDescriptor[], _activeInput: EditorInput | undefined): void {}
}
