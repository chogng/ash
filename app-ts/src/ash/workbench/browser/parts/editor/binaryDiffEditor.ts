import { BINARY_DIFF_EDITOR_ID } from '../../../common/editor.js';
import { isBinaryDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import type { IEditorPaneDescriptor } from '../../editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BaseBinaryResourceEditor } from "./binaryEditor.js";
import type { EditorInput } from "./editorInput.js";
import { EditorPaneMatch } from "./editorPane.js";
import { SideBySideEditor } from "./sideBySideEditor.js";

/** Keeps each side's file-size metadata visible to comparison commands and status UI. */
export class BinaryResourceDiffEditor extends SideBySideEditor {
	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super(
			BINARY_DIFF_EDITOR_ID,
			instantiationService.createInstance(BaseBinaryResourceEditor),
			instantiationService.createInstance(BaseBinaryResourceEditor),
		);
	}

	override async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isBinaryDiffEditorInput(input)) throw new TypeError("Binary diff editor requires two binary file inputs");
		await super.setInput(input, signal);
	}

	getMetadata(): string | undefined {
		const original = this.getSecondaryEditorPane() as BaseBinaryResourceEditor;
		const modified = this.getPrimaryEditorPane() as BaseBinaryResourceEditor;
		const before = original.getMetadata();
		const after = modified.getMetadata();
		return before && after ? `${before} ↔ ${after}` : undefined;
	}
}

export function binaryDiffEditorDescriptor(): IEditorPaneDescriptor {
	return {
		id: BINARY_DIFF_EDITOR_ID,
		name: "Binary Diff Editor",
		canOpen: input => isBinaryDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: options => {
			if (!options.instantiationService) throw new Error("Binary diff editor requires Workbench instantiation services");
			return options.instantiationService.createInstance(BinaryResourceDiffEditor);
		},
	};
}
