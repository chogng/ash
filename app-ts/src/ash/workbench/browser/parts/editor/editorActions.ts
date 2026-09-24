import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { IEditorPart } from "./editorPart.js";
import type { ExtensionFileTemplateDefinition } from "../../../services/extensions/common/extensionFileTemplate.js";
import { IExtensionService } from "../../../services/extensions/common/extensionService.js";
import { IUntitledTextEditorService } from "../../../services/untitled/common/untitledTextEditorService.js";
import type { EditorIdentifier } from "../../../services/editor/common/editorState.js";
import type { IEditorPaneDescriptor } from "./editorPane.js";
import { IEditorPartsService } from "./editorParts.js";

export const SplitEditorHorizontalCommandId =
	"workbench.action.splitEditorHorizontal";

registerAction2(class SplitEditorHorizontalAction extends Action2 {
	constructor() {
		super({
			id: SplitEditorHorizontalCommandId,
			title: "Split Editor Horizontal",
			tooltip: "Split Editor Horizontal",
			icon: lxiconsLibrary.splitHorizontal,
			f1: true,
			menu: {
				id: MenuId.EditorTitle,
				group: "navigation",
				order: 1,
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorPart).splitActiveGroupHorizontal();
	}
});

export const SplitEditorVerticalCommandId = "workbench.action.splitEditorVertical";

registerAction2(class SplitEditorVerticalAction extends Action2 {
	constructor() {
		super({
			id: SplitEditorVerticalCommandId,
			title: "Split Editor Vertical",
			tooltip: "Split Editor Vertical",
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorPart).splitActiveGroupVertical();
	}
});

export const CloseActiveEditorCommandId = "workbench.action.closeActiveEditor";

registerAction2(class CloseActiveEditorAction extends Action2 {
	constructor() {
		super({
			id: CloseActiveEditorCommandId,
			title: "Close Editor",
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey("w", { primaryKey: true })) },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(IEditorPart);
		if (editor.activeInput) await editor.closeEditor(editor.activeInput);
	}
});

export const CloseAllEditorsCommandId = "workbench.action.closeAllEditors";

registerAction2(class CloseAllEditorsAction extends Action2 {
	constructor() {
		super({ id: CloseAllEditorsCommandId, title: "Close All Editors", f1: true });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorPart).closeAllEditors();
	}
});

export const ReopenClosedEditorCommandId = "workbench.action.reopenClosedEditor";

registerAction2(class ReopenClosedEditorAction extends Action2 {
	constructor() {
		super({
			id: ReopenClosedEditorCommandId,
			title: "Reopen Closed Editor",
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey("t", { primaryKey: true, shiftKey: true })) },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorPart).reopenClosedEditor();
	}
});

export const NavigateEditorMruCommandId = "workbench.action.navigateEditorMru";
export const NavigateEditorMruBackwardsCommandId = "workbench.action.navigateEditorMruBackwards";

registerAction2(class NavigateEditorMruAction extends Action2 {
	constructor() {
		super({
			id: NavigateEditorMruCommandId,
			title: "Open Next Recently Used Editor",
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey("tab", { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IEditorPart).activateEditorMru(1);
	}
});

registerAction2(class NavigateEditorMruBackwardsAction extends Action2 {
	constructor() {
		super({
			id: NavigateEditorMruBackwardsCommandId,
			title: "Open Previous Recently Used Editor",
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey("tab", { primaryKey: true, shiftKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IEditorPart).activateEditorMru(-1);
	}
});

interface OpenEditorQuickPickItem extends IQuickPickItem {
	readonly editor: EditorIdentifier;
}

export const ShowAllEditorsCommandId = "workbench.action.showAllEditors";

registerAction2(class ShowAllEditorsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllEditorsCommandId,
			title: "Show All Editors",
			f1: true,
			keybinding: { primary: Keybinding.chord(logicalKey("k", { primaryKey: true }), logicalKey("p", { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editorPart = accessor.get(IEditorPart);
		const items = editorPart.editorsMru.map(editor => ({
			editor,
			label: editorInputLabel(editor.input),
			description: `Group ${editorPart.groups.findIndex(group => group.id === editor.groupId) + 1}`,
			detail: editor.input.resource.toString(),
		}));
		showEditorPicker(accessor.get(IQuickInputService), items, "Select an open editor", item => {
			editorPart.activateEditorIdentifier(item.editor);
		});
	}
});

interface ReopenWithQuickPickItem extends IQuickPickItem {
	readonly descriptor: IEditorPaneDescriptor;
}

export const ReopenWithCommandId = "workbench.action.reopenWithEditor";

registerAction2(class ReopenWithAction extends Action2 {
	constructor() {
		super({ id: ReopenWithCommandId, title: "Reopen Editor With...", f1: true });
	}

	override run(accessor: ServicesAccessor): void {
		const editorPart = accessor.get(IEditorPart);
		const items = editorPart.getEditorPaneChoices().map(descriptor => ({
			descriptor,
			label: descriptor.name,
			description: descriptor.id,
		}));
		showEditorPicker(accessor.get(IQuickInputService), items, "Select an editor", item => {
			void editorPart.reopenActiveEditorWith(item.descriptor.id).catch(error => console.error("Could not reopen editor", error));
		});
	}
});

export const MoveEditorToNewWindowCommandId = "workbench.action.moveEditorToNewWindow";

registerAction2(class MoveEditorToNewWindowAction extends Action2 {
	constructor() {
		super({
			id: MoveEditorToNewWindowCommandId,
			title: "Move Editor into New Window",
			f1: true,
			menu: {
				id: MenuId.EditorTitle,
				group: "2_open",
				order: 1,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorPartsService).moveActiveEditorToNewWindow();
	}
});

export const NewUntitledTextEditorCommandId =
	"workbench.action.files.newUntitledFile";

registerAction2(class NewUntitledTextEditorAction extends Action2 {
	constructor() {
		super({
			id: NewUntitledTextEditorCommandId,
			title: "New Untitled Text Editor",
			tooltip: "New Untitled Text Editor",
			icon: lxiconsLibrary.add,
			f1: true,
			keybinding: {
				primary: Keybinding.single(logicalKey("n", { primaryKey: true })),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const untitled = accessor.get(IUntitledTextEditorService).create();
		return accessor.get(IEditorPart).openEditor({
			resource: untitled.resource,
			label: untitled.label,
			initialText: untitled.initialText,
			languageId: untitled.languageId,
		}).then(() => undefined);
	}
});

export const NewFileFromTemplateCommandId = "workbench.action.files.newFileFromTemplate";

interface FileTemplateQuickPickItem extends IQuickPickItem {
	readonly template: ExtensionFileTemplateDefinition;
}

registerAction2(class NewFileFromTemplateAction extends Action2 {
	constructor() {
		super({
			id: NewFileFromTemplateCommandId,
			title: "New File from Template",
			tooltip: "New File from Template",
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, group: "1_file", order: 0 },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const templates = accessor.get(IExtensionService).fileTemplates.currentCatalog.templates;
		if (templates.length === 0) return;
		const picker = accessor.get(IQuickInputService).createQuickPick<FileTemplateQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = "Select a file template";
		picker.items = templates.map(template => ({
			template,
			label: template.label,
			description: template.extensionId,
			...(template.description === undefined ? {} : { detail: template.description }),
		}));
		disposables.add(picker.onDidAccept(item => {
			picker.hide();
			const untitled = accessor.get(IUntitledTextEditorService).create({ initialText: item.template.body, languageId: item.template.languageId });
			void accessor.get(IEditorPart).openEditor({
				resource: untitled.resource,
				label: untitled.label,
				initialText: untitled.initialText,
				languageId: untitled.languageId,
			}).catch(error => console.error("Could not create file from extension template", error));
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

/** Saves the active pane through the Workbench-owned editor lifecycle. */
export const SaveActiveEditorCommandId =
	"workbench.action.files.save";

registerAction2(class SaveActiveEditorAction extends Action2 {
	constructor() {
		super({
			id: SaveActiveEditorCommandId,
			title: "Save",
			tooltip: "Save",
			f1: true,
			menu: {
				id: MenuId.MenubarFileMenu,
				group: "1_file",
				order: 1,
			},
			keybinding: {
				primary: Keybinding.single(logicalKey("s", { primaryKey: true })),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorPart).saveActiveEditor();
	}
});

function showEditorPicker<TItem extends IQuickPickItem>(
	quickInputService: IQuickInputService,
	items: readonly TItem[],
	placeholder: string,
	onAccept: (item: TItem) => void,
): void {
	if (items.length === 0) return;
	const picker = quickInputService.createQuickPick<TItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.placeholder = placeholder;
	picker.items = items;
	disposables.add(picker.onDidAccept(item => {
		picker.hide();
		onAccept(item);
	}));
	disposables.add(picker.onDidHide(() => disposables.dispose()));
	picker.show();
}

function editorInputLabel(input: { readonly resource: { readonly path: string; toString(): string }; readonly label?: string }): string {
	if (input.label?.trim()) return input.label;
	const path = decodeURIComponent(input.resource.path).replace(/\/+$/u, "");
	const separator = path.lastIndexOf("/");
	return path.slice(separator + 1) || input.resource.toString();
}
