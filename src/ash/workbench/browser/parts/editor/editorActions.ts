import { localize2 } from '../../../../nls.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Action2, MenuId, MenusRegistry, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { IQuickAccessController } from "../../../../platform/quickinput/common/quickAccess.js";
import { IEditorPart } from "./editorPart.js";
import type { ExtensionFileTemplateDefinition } from "../../../services/extensions/common/extensionFileTemplate.js";
import { IExtensionService } from "../../../services/extensions/common/extensionService.js";
import { IUntitledTextEditorService } from "../../../services/untitled/common/untitledTextEditorService.js";
import { UntitledTextEditorInput } from "../../../services/untitled/common/untitledTextEditorInput.js";
import { EditorsVisibleContext } from "../../../common/contextkeys.js";
import { IEditorPartsService } from "./editorParts.js";
import { AllEditorsByMostRecentlyUsedQuickAccess } from "./editorQuickAccess.js";
import { IBreadcrumbsService } from "./breadcrumbs.js";
import { GoFilter, IHistoryService } from '../../../services/history/common/history.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { resolveCommandsContext } from './editorCommandsContext.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EditorOpenSideBySideDirectionConfiguration } from '../../../services/editor/common/editorConfiguration.js';

export const SPLIT_EDITOR = 'workbench.action.splitEditor';

registerAction2(class SplitEditorAction extends Action2 {
	constructor() {
		super({
			id: SPLIT_EDITOR, title: localize2('workbench.splitEditor', 'Split Editor'), f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('\\', { primaryKey: true })) }
		});
	}
	override run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		const direction = accessor.get(IConfigurationService).getValue<string>(EditorOpenSideBySideDirectionConfiguration);
		return splitEditors(accessor, args, direction === 'down' ? Direction.Down : Direction.Right);
	}
});

for (const down of [false, true]) {
	const primary = {
		id: SPLIT_EDITOR,
		title: down ? localize2('workbench.splitEditorDown', 'Split Down') : localize2('workbench.splitEditorRight', 'Split Right'),
		icon: down ? Lxicon.splitVertical : Lxicon.splitHorizontal
	};
	const alternate = {
		id: down ? 'workbench.action.splitEditorRight' : 'workbench.action.splitEditorDown',
		title: down ? localize2('workbench.splitEditorRight', 'Split Right') : localize2('workbench.splitEditorDown', 'Split Down'),
		icon: down ? Lxicon.splitHorizontal : Lxicon.splitVertical
	};
	MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: primary, alt: alternate, group: 'navigation', order: 100000,
		when: down ? ContextKeyExpr.equals('config.workbench.editor.openSideBySideDirection', 'down') : ContextKeyExpr.notEquals('config.workbench.editor.openSideBySideDirection', 'down')
	});
}

export const FocusBreadcrumbsCommandId = "workbench.action.focusBreadcrumbs";
export const ToggleEditorGroupLockCommandId = "workbench.action.toggleEditorGroupLock";

registerAction2(class ToggleEditorGroupLockAction extends Action2 {
	constructor() {
		super({
			id: ToggleEditorGroupLockCommandId,
			title: localize2({ bundle: "ash", key: "workbench.toggleEditorGroupLock" }, "Toggle Editor Group Lock"),
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
			title: localize2({ bundle: "ash", key: "workbench.focusBreadcrumbs" }, "Focus Breadcrumbs"),
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
			title: localize2({ bundle: 'ash', key: 'workbench.splitEditorHorizontal' }, 'Split Editor Horizontal'),
			tooltip: localize2({ bundle: 'ash', key: 'workbench.splitEditorHorizontal' }, 'Split Editor Horizontal'),
			icon: Lxicon.splitHorizontal,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		return splitEditors(accessor, args, Direction.Right);
	}
});

export const SplitEditorVerticalCommandId = "workbench.action.splitEditorVertical";

registerAction2(class SplitEditorVerticalAction extends Action2 {
	constructor() {
		super({
			id: SplitEditorVerticalCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.splitEditorVertical' }, 'Split Editor Vertical'),
			tooltip: localize2({ bundle: 'ash', key: 'workbench.splitEditorVertical' }, 'Split Editor Vertical'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		return splitEditors(accessor, args, Direction.Down);
	}
});

for (const definition of [
	{ id: 'workbench.action.splitEditorUp', key: 'workbench.splitEditorUp', title: 'Split Up', direction: Direction.Up, order: 10 },
	{ id: 'workbench.action.splitEditorDown', key: 'workbench.splitEditorDown', title: 'Split Down', direction: Direction.Down, order: 20 },
	{ id: 'workbench.action.splitEditorLeft', key: 'workbench.splitEditorLeft', title: 'Split Left', direction: Direction.Left, order: 30 },
	{ id: 'workbench.action.splitEditorRight', key: 'workbench.splitEditorRight', title: 'Split Right', direction: Direction.Right, order: 40 },
]) {
	registerAction2(class SplitEditorAction extends Action2 {
		constructor() {
			super({
				id: definition.id,
				title: localize2({ bundle: 'ash', key: definition.key }, definition.title),
				f1: true,
				precondition: EditorsVisibleContext.isEqualTo(true),
				menu: { id: MenuId.EditorTitleContext, group: '5_split', order: definition.order },
			});
		}

		override run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
			return splitEditors(accessor, args, definition.direction);
		}
	});
}

async function splitEditors(accessor: ServicesAccessor, args: readonly unknown[], direction: Direction): Promise<void> {
	const part = accessor.get(IEditorPart);
	const groups = accessor.get(IEditorGroupsService);
	if (args.length === 0 && groups.activeGroup.inputs.length === 0) {
		await part.splitActiveGroup(direction);
		return;
	}
	const context = resolveCommandsContext(args, groups);
	for (const { group, editors } of context.groupedEditors) {
		await part.splitEditors(group.id, editors, direction);
	}
}

export const CloseAllEditorsCommandId = "workbench.action.closeAllEditors";

registerAction2(class CloseAllEditorsAction extends Action2 {
	constructor() {
		super({
			id: CloseAllEditorsCommandId,
			title: localize2({ bundle: "ash", key: "workbench.closeAllEditors" }, "Close All Editors"),
			f1: true,
			precondition: EditorsVisibleContext.isEqualTo(true),
			menu: { id: MenuId.MenubarFileMenu, group: "6_close", order: 1 },
			keybinding: { primary: Keybinding.chord(logicalKey("k", { primaryKey: true }), logicalKey("w", { primaryKey: true })) },
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
			title: localize2({ bundle: "ash", key: "workbench.reopenClosedEditor" }, "Reopen Closed Editor"),
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
			title: localize2({ bundle: "ash", key: "workbench.navigateEditorBack" }, "Go Back"),
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
			title: localize2({ bundle: "ash", key: "workbench.navigateEditorForward" }, "Go Forward"),
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

registerAction2(class NavigateBackwardsInEditsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.navigateBackInEditLocations',
			title: localize2({ bundle: 'ash', key: 'workbench.navigateBackInEditLocations' }, 'Go Back in Edit Locations'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHistoryService).goBack(GoFilter.EDITS);
	}
});

registerAction2(class NavigateForwardInEditsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.navigateForwardInEditLocations',
			title: localize2({ bundle: 'ash', key: 'workbench.navigateForwardInEditLocations' }, 'Go Forward in Edit Locations'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHistoryService).goForward(GoFilter.EDITS);
	}
});

registerAction2(class NavigateBackwardsInNavigationsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.navigateBackInNavigationLocations',
			title: localize2({ bundle: 'ash', key: 'workbench.navigateBackInNavigationLocations' }, 'Go Back in Navigation Locations'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHistoryService).goBack(GoFilter.NAVIGATION);
	}
});

registerAction2(class NavigateForwardInNavigationsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.navigateForwardInNavigationLocations',
			title: localize2({ bundle: 'ash', key: 'workbench.navigateForwardInNavigationLocations' }, 'Go Forward in Navigation Locations'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IHistoryService).goForward(GoFilter.NAVIGATION);
	}
});

registerAction2(class NavigateEditorMruAction extends Action2 {
	constructor() {
		super({
			id: NavigateEditorMruCommandId,
			title: localize2({ bundle: "ash", key: "workbench.nextRecentlyUsedEditor" }, "Open Next Recently Used Editor"),
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
			title: localize2({ bundle: "ash", key: "workbench.previousRecentlyUsedEditor" }, "Open Previous Recently Used Editor"),
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
			title: localize2({ bundle: "ash", key: "workbench.showAllEditors" }, "Show All Editors"),
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
			title: localize2({ bundle: 'ash.workbench', key: 'command.MoveEditorToNewWindowAction' }, "Move Editor into New Window"),
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
			title: localize2({ bundle: "ash", key: "workbench.newFileFromTemplate" }, "New File from Template"),
			tooltip: localize2({ bundle: "ash", key: "workbench.newFileFromTemplate" }, "New File from Template"),
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
			const untitled = accessor.get(IUntitledTextEditorService).create({ initialValue: item.template.body, languageId: item.template.languageId });
			void accessor.get(IEditorPart).openEditor(new UntitledTextEditorInput(untitled)).catch(error => console.error("Could not create file from extension template", error));
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});
