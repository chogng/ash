import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { EditorsVisibleContext, ResourceSchemeContext, WorkspaceFolderCountContext } from '../../../common/contextkeys.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { ASH_REMOTE_SCHEME } from '../../../../platform/remote/common/remote.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID, NEW_UNTITLED_FILE_COMMAND_ID, OPEN_FILE_COMMAND_ID, SAVE_FILE_COMMAND_ID } from './fileConstants.js';
import { copyFilePath, copyRelativeFilePath, resolveFileResource } from './fileCommands.js';
import { createNewFile, createNewFolder, deleteExplorerItem, DELETE_FILE_COMMAND_ID, DOWNLOAD_COMMAND_ID, NEW_FILE_COMMAND_ID, NEW_FOLDER_COMMAND_ID, openExplorerItemToSide, OPEN_TO_SIDE_COMMAND_ID, renameExplorerItem, RENAME_FILE_COMMAND_ID } from './fileActions.js';
import { FileDownload } from './fileImportExport.js';
import { FileEditorInput } from './editors/fileEditorInput.js';
import { ExplorerFocusedContext } from './files.js';

registerAction2(class OpenFileAction extends Action2 {
	constructor() {
		super({
			id: OPEN_FILE_COMMAND_ID,
			title: localizedString('ash', 'workbench.openFile', 'Open File...'),
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, group: '1_file', order: 0 },
			keybinding: { primary: Keybinding.single(logicalKey('o', { primaryKey: true })) },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const resources = await accessor.get(IFileDialogService).showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
		for (const resource of resources ?? []) await accessor.get(IEditorService).openEditor(new FileEditorInput(resource));
	}
});

registerAction2(class NewUntitledTextEditorAction extends Action2 {
	constructor() {
		super({
			id: NEW_UNTITLED_FILE_COMMAND_ID,
			title: localizedString('ash', 'workbench.newUntitledFile', 'New Untitled Text Editor'),
			tooltip: localizedString('ash', 'workbench.newUntitledFile', 'New Untitled Text Editor'),
			icon: Lxicon.add,
			f1: true,
			menu: { id: MenuId.MenubarFileMenu, group: '1_file', order: -1 },
			keybinding: {
				primary: Keybinding.single(logicalKey('n', { primaryKey: true })),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const untitled = accessor.get(IUntitledTextEditorService).create();
		return accessor.get(IEditorPart).openEditor(untitled).then(() => undefined);
	}
});

registerAction2(class SaveActiveEditorAction extends Action2 {
	constructor() {
		super({
			id: SAVE_FILE_COMMAND_ID,
			title: localizedString('ash', 'workbench.save', 'Save'),
			tooltip: localizedString('ash', 'workbench.save', 'Save'),
			f1: true,
			menu: {
				id: MenuId.MenubarFileMenu,
				when: EditorsVisibleContext.isEqualTo(true),
				group: '3_save',
				order: 1,
			},
			keybinding: {
				primary: Keybinding.single(logicalKey('s', { primaryKey: true })),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorPart).saveActiveEditor();
	}
});

const fileResourceWhen = ContextKeyExpr.or(
	ResourceSchemeContext.isEqualTo(Schemas.file),
	ResourceSchemeContext.isEqualTo(ASH_REMOTE_SCHEME),
);
const selectedFileWhen = ContextKeyExpr.has('ashExplorerIsFile');
const canCreateWhen = ContextKeyExpr.has('ashExplorerCanCreate');
const selectedResourceWhen = ContextKeyExpr.and(ContextKeyExpr.has('ashExplorerHasResource'), fileResourceWhen);
const canModifyWhen = ContextKeyExpr.has('ashExplorerCanModify');
const explorerShortcutWhen = ContextKeyExpr.and(ExplorerFocusedContext.isEqualTo(true), canModifyWhen);
const downloadWhen = ContextKeyExpr.and(selectedFileWhen, ContextKeyExpr.or(IsWebContext.isEqualTo(true), ResourceSchemeContext.isEqualTo(ASH_REMOTE_SCHEME)));

CommandsRegistry.registerMany([
	{ id: NEW_FILE_COMMAND_ID, handler: createNewFile },
	{ id: NEW_FOLDER_COMMAND_ID, handler: createNewFolder },
	{ id: OPEN_TO_SIDE_COMMAND_ID, handler: openExplorerItemToSide },
	{ id: DOWNLOAD_COMMAND_ID, handler: (accessor, resource) => new FileDownload(accessor.get(IFileService)).download(resolveFileResource(accessor, resource), document) },
	{ id: COPY_PATH_COMMAND_ID, handler: copyFilePath },
	{ id: COPY_RELATIVE_PATH_COMMAND_ID, handler: copyRelativeFilePath },
	{ id: RENAME_FILE_COMMAND_ID, handler: renameExplorerItem },
	{ id: DELETE_FILE_COMMAND_ID, handler: deleteExplorerItem },
]);

MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: NEW_FILE_COMMAND_ID, title: localizedString('ash', 'workbench.newFile', 'New File...') }, when: ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0) });
MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: NEW_FOLDER_COMMAND_ID, title: localizedString('ash', 'files.newFolder', 'New Folder...') }, when: ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0) });
MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: COPY_PATH_COMMAND_ID, title: localizedString('ash', 'workbench.copyPath', 'Copy Path') }, when: fileResourceWhen });
MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id: COPY_RELATIVE_PATH_COMMAND_ID, title: localizedString('ash', 'workbench.copyRelativePath', 'Copy Relative Path') }, when: fileResourceWhen });

MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: NEW_FILE_COMMAND_ID, title: localizedString('ash', 'workbench.newFile', 'New File...') },
	when: canCreateWhen,
	group: 'navigation',
	order: 4,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: NEW_FOLDER_COMMAND_ID, title: localizedString('ash', 'files.newFolder', 'New Folder...') },
	when: canCreateWhen,
	group: 'navigation',
	order: 6,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: OPEN_TO_SIDE_COMMAND_ID, title: localizedString('ash', 'files.openToSide', 'Open to the Side') },
	when: selectedFileWhen,
	group: 'navigation',
	order: 10,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: DOWNLOAD_COMMAND_ID, title: localizedString('ash', 'workbench.downloadFile', 'Download File...') },
	when: downloadWhen,
	group: '5b_importexport',
	order: 10,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: COPY_PATH_COMMAND_ID, title: localizedString('ash', 'workbench.copyPath', 'Copy Path') },
	when: selectedResourceWhen,
	group: '6_copypath',
	order: 10,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: COPY_RELATIVE_PATH_COMMAND_ID, title: localizedString('ash', 'workbench.copyRelativePath', 'Copy Relative Path') },
	when: selectedResourceWhen,
	group: '6_copypath',
	order: 20,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: RENAME_FILE_COMMAND_ID, title: localizedString('ash', 'files.rename', 'Rename'), precondition: canModifyWhen },
	when: canModifyWhen,
	group: '7_modification',
	order: 10,
});
MenusRegistry.appendMenuItem(MenuId.ExplorerContext, {
	command: { id: DELETE_FILE_COMMAND_ID, title: localizedString('ash', 'files.deletePermanently', 'Delete Permanently'), precondition: canModifyWhen },
	when: canModifyWhen,
	group: '7_modification',
	order: 20,
});

KeybindingsRegistry.registerKeybindingRule({
	command: RENAME_FILE_COMMAND_ID,
	keybinding: Keybinding.single(logicalKey(isMacintosh ? 'Enter' : 'F2')),
	when: explorerShortcutWhen,
	priority: KeybindingWeight.WorkbenchContrib + 10,
});
KeybindingsRegistry.registerKeybindingRule({
	command: DELETE_FILE_COMMAND_ID,
	keybinding: isMacintosh
		? Keybinding.single(logicalKey('Backspace', { primaryKey: true, altKey: true }))
		: Keybinding.single(logicalKey('Delete', { shiftKey: true })),
	when: explorerShortcutWhen,
	priority: KeybindingWeight.WorkbenchContrib + 10,
});
