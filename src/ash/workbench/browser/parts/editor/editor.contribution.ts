import { EditorPanes } from "../../editor.js";
import { binaryDiffEditorDescriptor } from "./binaryDiffEditor.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { QuickAccessRegistry } from "../../../../platform/quickinput/common/quickAccess.js";
import { localize } from "../../../../nls.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import "./editorActions.js";
import "./editorCommands.js";
import "./diffEditor.workbench.contribution.js";
import '../../../../editor/browser/widget/diffEditor/diffEditor.contribution.js';
import { ToggleCollapseUnchangedRegions } from '../../../../editor/browser/widget/diffEditor/commands.js';
import { DIFF_OPEN_SIDE, GOTO_NEXT_CHANGE, GOTO_PREVIOUS_CHANGE, registerDiffEditorCommands } from "./diffEditorCommands.js";
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ActiveEditorContext, EditorsVisibleContext } from '../../../common/contextkeys.js';
import { DIFF_EDITOR_ID } from '../../../common/editor/diffEditorInput.js';
import { EditorAutoSave } from "./editorAutoSave.js";
import { IEditorPart } from "./editorPart.js";
import { AllEditorsByMostRecentlyUsedQuickAccess } from "./editorQuickAccess.js";
import { ChangeEncodingAction, ChangeEOLAction, ChangeLanguageAction, EditorStatusContribution } from "./editorStatus.js";
import { DynamicEditorConfigurations } from "./editorConfiguration.js";

registerAction2(ChangeLanguageAction);
registerAction2(ChangeEOLAction);
registerAction2(ChangeEncodingAction);

EditorPanes.registerEditorPane(binaryDiffEditorDescriptor());

registerDiffEditorCommands();

MenusRegistry.appendMenuItem(MenuId.EditorTitleContext, {
	submenu: MenuId.EditorSplitMoveSubmenu,
	title: localize('workbench.splitMenu', 'Split'),
	group: '5_split', order: 15,
	when: EditorsVisibleContext.isEqualTo(true),
});

const diffEditorActive = ActiveEditorContext.isEqualTo(DIFF_EDITOR_ID);
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: new ToggleCollapseUnchangedRegions().desc,
	when: diffEditorActive,
	group: 'navigation', order: 21,
});
for (const [id, key, title, icon, order] of [
	[GOTO_PREVIOUS_CHANGE, 'command.PreviousChangeAction', 'Go to Previous Change', Lxicon.arrowUp, 10],
	[GOTO_NEXT_CHANGE, 'command.NextChangeAction', 'Go to Next Change', Lxicon.arrowDown, 11],
	[DIFF_OPEN_SIDE, 'compare.openSide', 'Open Active Diff Side', Lxicon.goToFile, 22],
] as const) {
	MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: { id, title: localize({ bundle: 'ash.workbench', key }, title), icon },
		when: diffEditorActive,
		group: 'navigation', order,
	});
}

registerWorkbenchContribution(
	DynamicEditorConfigurations.ID,
	WorkbenchPhase.AfterRestored,
	() => new DynamicEditorConfigurations(),
);

QuickAccessRegistry.register({
	prefix: AllEditorsByMostRecentlyUsedQuickAccess.PREFIX,
	get placeholder() { return localize("workbench.editorQuickAccessPlaceholder", "Select an open editor"); },
	get helpLabel() { return localize("workbench.showAllEditors", "Show All Editors"); },
	ctor: AllEditorsByMostRecentlyUsedQuickAccess,
});

registerWorkbenchContribution(
	EditorStatusContribution.ID,
	WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(EditorStatusContribution,
		accessor.get(IEditorPart),
		accessor.get(IStatusbarService),
	),
);

registerWorkbenchContribution(
	EditorAutoSave.ID,
	WorkbenchPhase.AfterRestored,
	accessor => new EditorAutoSave(
		accessor.get(IEditorPart),
		accessor.get(IWorkingCopyService),
		accessor.get(IConfigurationService),
	),
);
