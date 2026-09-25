import './media/editorquickaccess.css';
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
			const editorState = new Map(this.editorPart.groups.flatMap(group => group.editors.map(editor => [editor.instanceId, editor] as const)));
			picker.items = this.editorPart.editorsMru.map(editor => ({
				editor,
				className: editorState.get(editor.instanceId)?.isDirty
					? 'ash-editor-quick-pick-item dirty'
					: 'ash-editor-quick-pick-item',
				buttons: [{ id: 'close', label: localize('workbench.closeEditor', 'Close Editor') }],
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
		disposables.add(picker.onDidTriggerItemButton(({ item, button }) => {
			if (button.id !== 'close') return;
			void this.editorPart.closeEditorIdentifier((item as EditorQuickPickItem).editor).catch(error => {
				console.error('Could not close editor from Quick Pick', error);
			});
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
