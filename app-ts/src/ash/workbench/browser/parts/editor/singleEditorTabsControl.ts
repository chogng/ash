import type { EditorInput } from "./editorInput.js";
import type { EditorTabDescriptor, EditorTabsDelegate } from "./editorTabsControl.js";
import { editorInputKey } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";

/** Presents only the active editor while retaining the normal tab interactions. */
export class SingleEditorTabsControl extends MultiEditorTabsControl {
	constructor(container: HTMLElement, delegate: EditorTabsDelegate) {
		super(container, delegate);
		this.domNode.classList.add("ash-single-editor-tabs-control");
	}

	override setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined): void {
		const active = activeInput
			? editors.find(editor => editorInputKey(editor.input) === editorInputKey(activeInput))
			: undefined;
		super.setEditors(active ? [active] : [], activeInput);
	}
}
