import { Lxicon } from "../../../../base/common/lxicons.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { localizedString } from "../../../../platform/action/common/action.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { IQuickAccessController } from "../../../../platform/quickinput/common/quickAccess.js";
import { IEditorPart } from "./editorPart.js";
import type { ExtensionFileTemplateDefinition } from "../../../services/extensions/common/extensionFileTemplate.js";
import { IExtensionService } from "../../../services/extensions/common/extensionService.js";
import { IUntitledTextEditorService } from "../../../services/untitled/common/untitledTextEditorService.js";
import { EditorsVisibleContext } from "../../../common/contextkeys.js";
import { IEditorPartsService } from "./editorParts.js";
import { AllEditorsByMostRecentlyUsedQuickAccess } from "./editorQuickAccess.js";
import { IBreadcrumbsService } from "./breadcrumbs.js";
import { IHistoryService } from '../../../services/history/common/history.js';

export const FocusBreadcrumbsCommandId = "workbench.action.focusBreadcrumbs";
export const ToggleEditorGroupLockCommandId = "workbench.action.toggleEditorGroupLock";

registerAction2(class ToggleEditorGroupLockAction extends Action2 {
	constructor() {
		super({
			id: ToggleEditorGroupLockCommandId,
			title: localizedString("ash", "workbench.toggleEditorGroupLock", "Toggle Editor Group Lock"),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IEditorPart).toggleActiveGroupLock();
	}
});

registerAction2(class FocusBreadcrumbsAction extends Action2 {
	constructor() {
		super({
			id: FocusBreadcrumbsCommandId,
			title: localizedString("ash", "workbench.focusBreadcrumbs", "Focus Breadcrumbs"),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editor = accessor.get(IEditorPart);
		accessor.get(IBreadcrumbsService).getWidget(editor.activeGroup.id)?.focus();
	}
});

export const SplitEditorHorizontalCommandId =
	"workbench.action.splitEditorHorizontal";

registerAction2(class SplitEditorHorizontalAction extends Action2 {
	constructor() {
		super({
			id: SplitEditorHorizontalCommandId,
			title: "Split Editor Horizontal",
			tooltip: "Split Editor Horizontal",
			icon: Lxicon.splitHorizontal,
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

export const CloseAllEditorsCommandId = "workbench.action.closeAllEditors";

registerAction2(class CloseAllEditorsAction extends Action2 {
	constructor() {
		super({
			id: CloseAllEditorsCommandId,
			title: localizedString("ash", "workbench.closeAllEditors", "Close All Editors"),
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, when: EditorsVisibleContext.isEqualTo(true), group: "4_close", order: 2 },
		});
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
			title: localizedString("ash", "workbench.reopenClosedEditor", "Reopen Closed Editor"),
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, group: "4_close", order: 3 },
			keybinding: { primary: Keybinding.single(logicalKey("t", { primaryKey: true, shiftKey: true })) },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorPart).reopenClosedEditor();
	}
});

export const NavigateEditorMruCommandId = "workbench.action.navigateEditorMru";
export const NavigateEditorMruBackwardsCommandId = "workbench.action.navigateEditorMruBackwards";
export const NavigateEditorBackCommandId = "workbench.action.navigateBack";
export const NavigateEditorForwardCommandId = "workbench.action.navigateForward";

registerAction2(class NavigateEditorBackAction extends Action2 {
	constructor() {
		super({
			id: NavigateEditorBackCommandId,
			title: localizedString("ash", "workbench.navigateEditorBack", "Go Back"),
			icon: Lxicon.arrowLeft,
			precondition: ContextKeyExpr.has('canNavigateBack'),
			f1: true,
			keybinding: {
				primary: Keybinding.single(logicalKey('ArrowLeft', { altKey: true })),
				linux: { primary: Keybinding.single(logicalKey('-', { ctrlKey: true, altKey: true })) },
				mac: { primary: Keybinding.single(logicalKey('-', { ctrlKey: true })) },
			},
			menu: [
				{ id: MenuId.TouchBarContext, group: 'navigation', order: 0 },
				{ id: MenuId.MenubarGoMenu, group: '1_history_nav', order: 1 },
				{ id: MenuId.CommandCenter, group: 'navigation', order: 1 },
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHistoryService).goBack();
	}
});

registerAction2(class NavigateEditorForwardAction extends Action2 {
	constructor() {
		super({
			id: NavigateEditorForwardCommandId,
			title: localizedString("ash", "workbench.navigateEditorForward", "Go Forward"),
			icon: Lxicon.arrowRight,
			precondition: ContextKeyExpr.has('canNavigateForward'),
			f1: true,
			keybinding: {
				primary: Keybinding.single(logicalKey('ArrowRight', { altKey: true })),
				linux: { primary: Keybinding.single(logicalKey('-', { ctrlKey: true, shiftKey: true })) },
				mac: { primary: Keybinding.single(logicalKey('-', { ctrlKey: true, shiftKey: true })) },
			},
			menu: [
				{ id: MenuId.TouchBarContext, group: 'navigation', order: 1 },
				{ id: MenuId.MenubarGoMenu, group: '1_history_nav', order: 2 },
				{ id: MenuId.CommandCenter, group: 'navigation', order: 2 },
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHistoryService).goForward();
	}
});

registerAction2(class NavigateEditorMruAction extends Action2 {
	constructor() {
		super({
			id: NavigateEditorMruCommandId,
			title: localizedString("ash", "workbench.nextRecentlyUsedEditor", "Open Next Recently Used Editor"),
			f1: true,
			menu: { id: MenuId.MenubarGoMenu, when: EditorsVisibleContext.isEqualTo(true), group: "1_editor", order: 1 },
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
			title: localizedString("ash", "workbench.previousRecentlyUsedEditor", "Open Previous Recently Used Editor"),
			f1: true,
			menu: { id: MenuId.MenubarGoMenu, when: EditorsVisibleContext.isEqualTo(true), group: "1_editor", order: 2 },
			keybinding: { primary: Keybinding.single(logicalKey("tab", { primaryKey: true, shiftKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IEditorPart).activateEditorMru(-1);
	}
});

export const ShowAllEditorsCommandId = "workbench.action.showAllEditors";

registerAction2(class ShowAllEditorsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllEditorsCommandId,
			title: localizedString("ash", "workbench.showAllEditors", "Show All Editors"),
			f1: true,
			menu: { id: MenuId.MenubarGoMenu, when: EditorsVisibleContext.isEqualTo(true), group: "1_editor", order: 3 },
			keybinding: { primary: Keybinding.chord(logicalKey("k", { primaryKey: true }), logicalKey("p", { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickAccessController).show(AllEditorsByMostRecentlyUsedQuickAccess.PREFIX);
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

export const NewFileFromTemplateCommandId = "workbench.action.files.newFileFromTemplate";

interface FileTemplateQuickPickItem extends IQuickPickItem {
	readonly template: ExtensionFileTemplateDefinition;
}

registerAction2(class NewFileFromTemplateAction extends Action2 {
	constructor() {
		super({
			id: NewFileFromTemplateCommandId,
			title: localizedString("ash", "workbench.newFileFromTemplate", "New File from Template"),
			tooltip: localizedString("ash", "workbench.newFileFromTemplate", "New File from Template"),
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
