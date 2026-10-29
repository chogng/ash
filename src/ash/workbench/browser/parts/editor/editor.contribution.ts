import { EditorPanes } from '../../editor.js';
import { binaryDiffEditorDescriptor } from './binaryDiffEditor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { localize } from '../../../../nls.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { CopyEditorToNewWindowCommandId, MoveEditorToNewWindowCommandId, ToggleEditorGroupLockCommandId } from './editorActions.js';
import { CLOSE_EDITOR_COMMAND_ID, CLOSE_EDITORS_IN_GROUP_COMMAND_ID, CLOSE_SAVED_EDITORS_COMMAND_ID } from './editorCommands.js';
import './diffEditor.workbench.contribution.js';
import '../../../../editor/browser/widget/diffEditor/diffEditor.contribution.js';
import { ToggleCollapseUnchangedRegions } from '../../../../editor/browser/widget/diffEditor/commands.js';
import { GOTO_NEXT_CHANGE, GOTO_PREVIOUS_CHANGE, registerDiffEditorCommands } from './diffEditorCommands.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ActiveEditorContext, ActiveEditorGroupLockedContext, EditorPartMaximizedEditorGroupContext, EditorPartMultipleEditorGroupsContext, EditorPartModalVisibleContext, EditorsVisibleContext, IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ConfigureEditorAction } from '../../actions/layoutActions.js';
import { DIFF_EDITOR_ID } from '../../../common/editor/diffEditorInput.js';
import { EditorAutoSave } from './editorAutoSave.js';
import { IEditorPart } from './editorPart.js';
import { ActiveGroupEditorsByMostRecentlyUsedQuickAccess, AllEditorsByMostRecentlyUsedQuickAccess } from './editorQuickAccess.js';
import { ChangeEncodingAction, ChangeEOLAction, ChangeLanguageAction, EditorStatusContribution } from './editorStatus.js';
import { DynamicEditorConfigurations } from './editorConfiguration.js';

const outsideModalEditor = EditorPartModalVisibleContext.isEqualTo(false);

MenusRegistry.appendMenuItem(MenuId.ModalEditorTitle, {
	command: { id: CLOSE_EDITOR_COMMAND_ID, title: localize('workbench.closeEditor', 'Close'), icon: Lxicon.close },
	group: 'navigation', order: 100, when: EditorPartModalVisibleContext.isEqualTo(true),
});

MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'workbench.action.showEditorsInGroup', title: localize('workbench.showOpenedEditors', 'Show Opened Editors') },
	group: '3_open', order: 10, when: outsideModalEditor,
});
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: CLOSE_EDITORS_IN_GROUP_COMMAND_ID, title: localize('workbench.editorCloseAll', 'Close All') },
	group: '5_close', order: 10, when: outsideModalEditor,
});
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: CLOSE_SAVED_EDITORS_COMMAND_ID, title: localize('workbench.closeSavedEditors', 'Close Saved') },
	group: '5_close', order: 20, when: outsideModalEditor,
});
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'workbench.action.toggleKeepEditors', title: localize('workbench.enablePreviewEditors', 'Enable Preview Editors'), toggled: ContextKeyExpr.equals('config.workbench.editor.enablePreview', true) },
	group: '7_settings', order: 10, when: outsideModalEditor,
});
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'workbench.action.toggleMaximizeEditorGroup', title: localize('workbench.maximizeEditorGroup', 'Maximize Group') },
	group: '8_group_operations', order: 5,
	when: ContextKeyExpr.and(EditorPartMultipleEditorGroupsContext.isEqualTo(true), EditorPartMaximizedEditorGroupContext.isEqualTo(false)),
});
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'workbench.action.toggleMaximizeEditorGroup', title: localize('workbench.unmaximizeEditorGroup', 'Unmaximize Group') },
	group: '8_group_operations', order: 5, when: EditorPartMaximizedEditorGroupContext.isEqualTo(true),
});
MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: ToggleEditorGroupLockCommandId, title: localize('workbench.lockEditorGroup', 'Lock Group'), toggled: ActiveEditorGroupLockedContext.isEqualTo(true) },
	group: '8_group_operations', order: 10, when: ContextKeyExpr.and(outsideModalEditor, IsAuxiliaryWindowContext.isEqualTo(false)),
});

registerAction2(ChangeLanguageAction);
registerAction2(ChangeEOLAction);
registerAction2(ChangeEncodingAction);

EditorPanes.registerEditorPane(binaryDiffEditorDescriptor());

registerDiffEditorCommands();

MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: ConfigureEditorAction.ID, title: localize('workbench.configureEditors', 'Configure Editors') },
	group: '9_configure', order: 10,
	when: EditorPartModalVisibleContext.isEqualTo(false),
});

MenusRegistry.appendMenuItem(MenuId.EditorTitleContext, {
	submenu: MenuId.EditorSplitMoveSubmenu,
	title: localize('workbench.splitMenu', 'Split'),
	group: '5_split', order: 15,
	when: EditorsVisibleContext.isEqualTo(true),
});

MenusRegistry.appendMenuItem(MenuId.EditorTitleContext, {
	command: { id: MoveEditorToNewWindowCommandId, title: localize({ bundle: 'ash.workbench', key: 'editor.moveIntoNewWindow' }, 'Move into New Window') },
	group: '7_new_window', order: 10,
	when: EditorsVisibleContext.isEqualTo(true),
});
MenusRegistry.appendMenuItem(MenuId.EditorTitleContext, {
	command: { id: CopyEditorToNewWindowCommandId, title: localize({ bundle: 'ash.workbench', key: 'editor.copyIntoNewWindow' }, 'Copy into New Window') },
	group: '7_new_window', order: 20,
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
	get placeholder() { return localize('workbench.editorQuickAccessPlaceholder', 'Select an open editor'); },
	get helpLabel() { return localize('workbench.showAllEditors', 'Show All Editors'); },
	ctor: AllEditorsByMostRecentlyUsedQuickAccess,
});

QuickAccessRegistry.register({
	prefix: ActiveGroupEditorsByMostRecentlyUsedQuickAccess.PREFIX,
	get placeholder() { return localize('workbench.editorQuickAccessPlaceholder', 'Select an open editor'); },
	get helpLabel() { return localize('workbench.showOpenedEditors', 'Show Opened Editors'); },
	ctor: ActiveGroupEditorsByMostRecentlyUsedQuickAccess,
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
