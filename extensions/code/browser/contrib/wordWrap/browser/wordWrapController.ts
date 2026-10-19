import { addDisposableListener, stopEvent } from "../../../../../../src/ash/base/browser/dom.js";
import { registerEditorContribution } from "../../../registration.js";
import { type ICodeEditor } from "../../../../../../src/ash/editor/browser/editorBrowser.js";
import { ICodeEditorService } from "../../../../../../src/ash/editor/browser/services/codeEditorService.js";
import { Disposable } from "../../../../../../src/ash/base/common/lifecycle.js";
import { localize } from "../../../../../../src/ash/nls.js";
import { EditorLineWrapping } from "../../../../../../src/ash/editor/common/config/editorOptions.js";
import { type View } from "../../../../../../src/ash/editor/browser/view.js";

const transientWordWrapState = 'transientWordWrapState';

/** Applies one text model's temporary word-wrap choice to its editor views. */
export class WordWrapController extends Disposable {
	constructor(
		input: HTMLElement,
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
		this._register(this.codeEditorService.onDidChangeTransientModelProperty(model => {
			if (model === this.viewport.textModel) {
				this.applyTransientState();
			}
		}));
		this.applyTransientState();
	}

	public toggle(): void {
		const model = this.viewport.textModel;
		const current = this.codeEditorService.getTransientModelProperty(model, transientWordWrapState);
		let next: 'on' | 'off' | undefined;
		if (!current) {
			next = this.viewport.lineWrapping === EditorLineWrapping.On ? 'off' : 'on';
		}
		this.codeEditorService.setTransientModelProperty(model, transientWordWrapState, next);
		const enabled = this.viewport.lineWrapping === EditorLineWrapping.On;
		this.viewport.announceAccessibilityStatus(enabled
			? localize("wordWrap.enabled", "Word wrap on")
			: localize("wordWrap.disabled", "Word wrap off"));
	}

	private applyTransientState(): void {
		const state = this.codeEditorService.getTransientModelProperty(this.viewport.textModel, transientWordWrapState) as 'on' | 'off' | undefined;
		this.editor.updateOptions({ wordWrapOverride2: state ?? 'inherit' });
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "z") return;
		stopEvent(event);
		this.toggle();
	}
}

registerEditorContribution({
	id: "editor.contrib.wordWrap", install: context => {
		if (context.kind !== "text") return;
		return context.instantiationService.createInstance(WordWrapController, context.controller.element, context.view, context.editor);
	}
});
