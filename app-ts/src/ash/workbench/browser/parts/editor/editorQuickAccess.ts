import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { onDidChangeNls, localize } from "../../../../nls.js";
import type { IQuickAccessProvider } from "../../../../platform/quickinput/common/quickAccess.js";
import type { IQuickPick, IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import type { EditorIdentifier } from "../../../services/editor/common/editorState.js";
import { IEditorPart } from "./editorPart.js";

interface EditorQuickPickItem extends IQuickPickItem {
	readonly editor: EditorIdentifier;
}

/** Searches open editors in the order they were last used. */
export class AllEditorsByMostRecentlyUsedQuickAccess implements IQuickAccessProvider {
	static readonly PREFIX = "edt mru ";

	constructor(@IEditorPart private readonly editorPart: IEditorPart) {}

	provide(picker: IQuickPick<IQuickPickItem>): DisposableStore {
		const disposables = new DisposableStore();
		const update = (): void => {
			picker.items = this.editorPart.editorsMru.map(editor => ({
				editor,
				label: editorInputLabel(editor.input),
				description: localize(
					"workbench.editorGroupNumber",
					"Group {0}",
					this.editorPart.groups.findIndex(group => group.id === editor.groupId) + 1,
				),
				detail: editor.input.resource.toString(),
			}));
		};
		disposables.add(this.editorPart.onDidChangeEditors(update));
		disposables.add(onDidChangeNls(update));
		disposables.add(picker.onDidAccept(item => {
			picker.hide();
			this.editorPart.activateEditorIdentifier((item as EditorQuickPickItem).editor);
			this.editorPart.focus();
		}));
		update();
		return disposables;
	}
}

function editorInputLabel(input: EditorIdentifier["input"]): string {
	if (input.label?.trim()) return input.label;
	const path = decodeURIComponent(input.resource.path).replace(/\/+$/u, "");
	const separator = path.lastIndexOf("/");
	return path.slice(separator + 1) || input.resource.toString();
}
