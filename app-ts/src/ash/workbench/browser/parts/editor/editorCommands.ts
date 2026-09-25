import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { localizedString } from "../../../../platform/action/common/action.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { EditorsVisibleContext } from "../../../common/contextkeys.js";
import { IEditorPart } from "./editorPart.js";
import { resolveCommandsContext } from "./editorCommandsContext.js";
import { showEditorTypePicker } from "./editorTypePicker.js";

export const CLOSE_EDITOR_COMMAND_ID = "workbench.action.closeActiveEditor";

registerAction2(class CloseActiveEditorAction extends Action2 {
	constructor() {
		super({
			id: CLOSE_EDITOR_COMMAND_ID,
			title: localizedString("ash", "workbench.closeEditor", "Close Editor"),
			f1: true,
			menu: {
				id: MenuId.MenubarFileMenu,
				when: EditorsVisibleContext.isEqualTo(true),
				group: "4_close",
				order: 1,
			},
			keybinding: { primary: Keybinding.single(logicalKey("w", { primaryKey: true })) },
		});
	}

	override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		const editor = accessor.get(IEditorPart);
		if (args.length > 0) {
			const context = resolveCommandsContext(args, editor);
			for (const { group, editors } of context.groupedEditors) {
				for (const input of editors) await group.closeEditor(input);
			}
			return;
		}
		for (const input of [...editor.activeGroup.selectedInputs]) await editor.activeGroup.closeEditor(input);
	}
});

export const REOPEN_WITH_COMMAND_ID = "workbench.action.reopenWithEditor";

registerAction2(class ReopenWithAction extends Action2 {
	constructor() {
		super({
			id: REOPEN_WITH_COMMAND_ID,
			title: localizedString("ash", "workbench.reopenWithEditor", "Reopen Editor With..."),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		showEditorTypePicker(accessor.get(IEditorPart), accessor.get(IQuickInputService));
	}
});
