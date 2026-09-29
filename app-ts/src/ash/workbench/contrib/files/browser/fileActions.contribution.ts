import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { EditorsVisibleContext, ResourceSchemeContext } from '../../../common/contextkeys.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { ASH_REMOTE_SCHEME } from '../../../../platform/remote/common/remote.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { COPY_PATH_COMMAND_ID, COPY_RELATIVE_PATH_COMMAND_ID, NEW_UNTITLED_FILE_COMMAND_ID, OPEN_FILE_COMMAND_ID, SAVE_FILE_COMMAND_ID } from './fileConstants.js';
import { copyFilePath, copyRelativeFilePath, resolveFileResource } from './fileCommands.js';
import { createNewFile, createNewFolder, deleteExplorerItem, DELETE_FILE_COMMAND_ID, DOWNLOAD_COMMAND_ID, NEW_FILE_COMMAND_ID, NEW_FOLDER_COMMAND_ID, openExplorerItemToSide, OPEN_TO_SIDE_COMMAND_ID, renameExplorerItem, RENAME_FILE_COMMAND_ID } from './fileActions.js';
import { FileDownload } from './fileImportExport.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

registerAction2(class NewFileAction extends Action2 {
	constructor() {
		super({
			id: NEW_FILE_COMMAND_ID,
			title: localizedString('ash', 'workbench.newFile', 'New File...'),
			f1: true,
			menu: { id: MenuId.ExplorerContext, group: 'navigation', order: 4 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return createNewFile(accessor);
	}
});

registerAction2(class NewFolderAction extends Action2 {
	constructor() {
		super({
			id: NEW_FOLDER_COMMAND_ID,
			title: localizedString('ash', 'files.newFolder', 'New Folder...'),
			f1: true,
			menu: { id: MenuId.ExplorerContext, group: 'navigation', order: 6 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return createNewFolder(accessor);
	}
});

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
	ResourceSchemeContext.isEqualTo('file'),
	ResourceSchemeContext.isEqualTo(ASH_REMOTE_SCHEME),
);

registerAction2(class DownloadFileAction extends Action2 {
	constructor() {
		super({
			id: DOWNLOAD_COMMAND_ID,
			title: localizedString('ash', 'workbench.downloadFile', 'Download File...'),
			f1: true,
			precondition: fileResourceWhen,
			menu: { id: MenuId.ExplorerContext, when: ContextKeyExpr.has('ashExplorerIsFile'), group: '5b_importexport', order: 10 },
		});
	}

	override run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
		return new FileDownload(accessor.get(IFileService)).download(resolveFileResource(accessor, resource), document);
	}
});

registerAction2(class CopyFilePathAction extends Action2 {
	constructor() {
		super({
			id: COPY_PATH_COMMAND_ID,
			title: localizedString('ash', 'workbench.copyPath', 'Copy Path'),
			f1: true,
			precondition: fileResourceWhen,
			menu: { id: MenuId.ExplorerContext, when: ContextKeyExpr.has('ashExplorerHasResource'), group: '6_copypath', order: 10 },
		});
	}

	override run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
		return copyFilePath(accessor, resource);
	}
});

registerAction2(class CopyRelativeFilePathAction extends Action2 {
	constructor() {
		super({
			id: COPY_RELATIVE_PATH_COMMAND_ID,
			title: localizedString('ash', 'workbench.copyRelativePath', 'Copy Relative Path'),
			f1: true,
			precondition: fileResourceWhen,
			menu: { id: MenuId.ExplorerContext, when: ContextKeyExpr.has('ashExplorerHasResource'), group: '6_copypath', order: 20 },
		});
	}

	override run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
		return copyRelativeFilePath(accessor, resource);
	}
});

registerAction2(class OpenExplorerItemToSideAction extends Action2 {
	constructor() {
		super({
			id: OPEN_TO_SIDE_COMMAND_ID,
			title: localizedString('ash', 'files.openToSide', 'Open to the Side'),
			f1: true,
			menu: { id: MenuId.ExplorerContext, when: ContextKeyExpr.has('ashExplorerIsFile'), group: 'navigation', order: 10 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return openExplorerItemToSide(accessor);
	}
});

registerAction2(class RenameExplorerItemAction extends Action2 {
	constructor() {
		super({
			id: RENAME_FILE_COMMAND_ID,
			title: localizedString('ash', 'files.rename', 'Rename'),
			f1: true,
			menu: { id: MenuId.ExplorerContext, when: ContextKeyExpr.has('ashExplorerCanModify'), group: '7_modification', order: 10 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return renameExplorerItem(accessor);
	}
});

registerAction2(class DeleteExplorerItemAction extends Action2 {
	constructor() {
		super({
			id: DELETE_FILE_COMMAND_ID,
			title: localizedString('ash', 'files.deletePermanently', 'Delete Permanently'),
			f1: true,
			menu: { id: MenuId.ExplorerContext, when: ContextKeyExpr.has('ashExplorerCanModify'), group: '7_modification', order: 20 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return deleteExplorerItem(accessor);
	}
});
