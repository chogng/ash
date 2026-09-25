import "./media/binaryEditorPane.css";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import { binaryDiffEditorDescriptor, createBinaryDiffEditorInput } from "../../../browser/parts/editor/binaryDiffEditor.js";
import { IEditorPart } from "../../../browser/parts/editor/editorPart.js";
import { EditorPanes } from "../../../browser/parts/editor/editorRegistry.js";
import { binaryFileEditorDescriptor } from '../../files/browser/editors/binaryFileEditor.js';
import type { EditorInput } from "../../../browser/parts/editor/editorInput.js";

EditorPanes.register(binaryFileEditorDescriptor());
EditorPanes.register(binaryDiffEditorDescriptor());

interface BinaryComparisonItem extends IQuickPickItem {
	readonly input: EditorInput;
}

registerAction2(class CompareBinaryEditorsAction extends Action2 {
	constructor() {
		super({
			id: "workbench.action.compareActiveFileAsBinary",
			title: "Compare Active File as Binary With...",
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editors = accessor.get(IEditorPart);
		const modified = editors.activeInput;
		if (!modified || !isFileInput(modified)) return;
		const candidates = editors.editorsMru
			.map(editor => editor.input)
			.filter(input => isFileInput(input) && input.resource.toString() !== modified.resource.toString());
		if (candidates.length === 0) return;
		const picker = accessor.get(IQuickInputService).createQuickPick<BinaryComparisonItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = "Select the original file to compare";
		picker.items = candidates.map(input => ({
			input,
			label: input.label ?? input.resource.path.split("/").at(-1) ?? input.resource.toString(),
			detail: input.resource.toString(),
		}));
		disposables.add(picker.onDidAccept(item => {
			picker.hide();
			void editors.openEditor(createBinaryDiffEditorInput(item.input, modified), { pinned: true });
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

function isFileInput(input: EditorInput): boolean {
	return input.resource.scheme === "file" || isRemoteResource(input.resource);
}
