import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExplorerService } from './files.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const NEW_FOLDER_COMMAND_ID = 'explorer.newFolder';
export const DOWNLOAD_COMMAND_ID = 'explorer.download';
export const RENAME_FILE_COMMAND_ID = 'renameFile';
export const DELETE_FILE_COMMAND_ID = 'deleteFile';
export const OPEN_TO_SIDE_COMMAND_ID = 'explorer.openToSide';

export async function renameExplorerItem(accessor: ServicesAccessor): Promise<void> {
	const item = accessor.get(IExplorerService).getContext()[0];
	if (!item || isWorkspaceRoot(accessor, item.resource)) return;
	const name = await accessor.get(IQuickInputService).input({
		title: localize({ bundle: 'ash', key: 'files.rename' }, 'Rename'),
		value: item.name,
		validateInput: async value => validFileName(value)
			? undefined
			: localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a file name without path separators.'),
	});
	if (name === undefined || name === item.name) return;
	if (!validFileName(name)) throw new Error(localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a file name without path separators.'));
	const parent = item.resource.path.slice(0, item.resource.path.lastIndexOf('/'));
	await accessor.get(IFileService).rename(item.resource, item.resource.withPath(`${parent}/${encodeURIComponent(name)}`), 'error');
}

export async function deleteExplorerItem(accessor: ServicesAccessor): Promise<void> {
	const item = accessor.get(IExplorerService).getContext()[0];
	if (!item || isWorkspaceRoot(accessor, item.resource)) return;
	const dialog = accessor.get(IDialogService);
	const result = await dialog.confirm({
		message: localize({ bundle: 'ash', key: 'files.deleteConfirm' }, 'Permanently delete {0}?', item.name),
		primaryButton: localize({ bundle: 'ash', key: 'files.deletePermanently' }, 'Delete Permanently'),
	});
	if (result.confirmed) await accessor.get(IFileService).delete(item.resource, 'error', 'recursive');
}

export async function openExplorerItemToSide(accessor: ServicesAccessor): Promise<void> {
	const item = accessor.get(IExplorerService).getContext()[0];
	if (item?.kind === FileKind.File) {
		await accessor.get(IEditorService).openEditor(new FileEditorInput(item.resource, { label: item.name }), { pinned: true }, 'sideGroup');
	}
}

function isWorkspaceRoot(accessor: ServicesAccessor, resource: URI): boolean {
	return accessor.get(IWorkspaceContextService).getWorkspace().folders.some(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, resource));
}

/** Creates a file in the selected Explorer folder and opens it in the editor. */
export async function createNewFile(accessor: ServicesAccessor): Promise<void> {
	const directory = await resolveCreationDirectory(accessor, 'file');
	if (!directory) return;
	const name = await accessor.get(IQuickInputService).input({
		title: localize({ bundle: 'ash', key: 'workbench.newFileName' }, 'New File Name'),
		placeHolder: localize({ bundle: 'ash', key: 'workbench.newFileNamePlaceholder' }, 'Enter a file name'),
		validateInput: async value => validFileName(value)
			? undefined
			: localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a file name without path separators.'),
	});
	if (name === undefined) return;
	if (!validFileName(name)) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a file name without path separators.'));
	}
	const resource = directory.withPath(`${directory.path.replace(/\/$/, '')}/${encodeURIComponent(name)}`);
	await accessor.get(IFileService).createFile(resource, 'error');
	await accessor.get(IEditorService).openEditor(new FileEditorInput(resource, { label: name }));
}

export async function createNewFolder(accessor: ServicesAccessor): Promise<void> {
	const directory = await resolveCreationDirectory(accessor, 'folder');
	if (!directory) return;
	const name = await accessor.get(IQuickInputService).input({
		title: localize({ bundle: 'ash', key: 'files.newFolderName' }, 'New Folder Name'),
		placeHolder: localize({ bundle: 'ash', key: 'files.newFolderPlaceholder' }, 'Enter a folder name'),
		validateInput: async value => validFileName(value)
			? undefined
			: localize({ bundle: 'ash', key: 'files.invalidName' }, 'Enter a name without path separators.'),
	});
	if (name === undefined) return;
	if (!validFileName(name)) throw new Error(localize({ bundle: 'ash', key: 'files.invalidName' }, 'Enter a name without path separators.'));
	await accessor.get(IFileService).createDirectory(directory.withPath(`${directory.path.replace(/\/$/, '')}/${encodeURIComponent(name)}`));
}

async function resolveCreationDirectory(accessor: ServicesAccessor, kind: 'file' | 'folder'): Promise<URI | undefined> {
	const workspace = accessor.get(IWorkspaceContextService).getWorkspace();
	if (workspace.folders.length === 0) {
		throw new Error(kind === 'file'
			? localize({ bundle: 'ash', key: 'workbench.newFileNoFolder' }, 'Open a folder to create a file.')
			: localize({ bundle: 'ash', key: 'files.newFolderNoFolder' }, 'Open a folder to create a new folder.'));
	}
	const quickInput = accessor.get(IQuickInputService);
	const selection = accessor.get(IExplorerService).getContext()[0];
	const selectionDirectory = selection?.kind === FileKind.Directory
		? selection.resource
		: selection?.resource.withPath(selection.resource.path.slice(0, selection.resource.path.lastIndexOf('/')));
	const selectedDirectory = selectionDirectory && workspace.folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(selectionDirectory, folder.uri))
		? selectionDirectory
		: undefined;
	const activeResource = accessor.get(IEditorService).activeEditor?.resource;
	const activeFolder = workspace.folders
		.filter(folder => activeResource && extUriBiasedIgnorePathCase.isEqualOrParent(activeResource, folder.uri))
		.sort((left, right) => right.uri.path.length - left.uri.path.length)[0];
	const folder = selectedDirectory ? undefined : activeFolder ?? (workspace.folders.length === 1
		? workspace.folders[0]
		: await pickWorkspaceFolder(quickInput, workspace.folders, kind));
	return selectedDirectory ?? folder?.uri;
}

function validFileName(value: string): boolean {
	return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f]/.test(value);
}

function pickWorkspaceFolder(quickInput: IQuickInputService, folders: readonly IWorkspaceFolder[], kind: 'file' | 'folder'): Promise<IWorkspaceFolder | undefined> {
	type FolderItem = IQuickPickItem & { readonly folder: IWorkspaceFolder };
	const picker = quickInput.createQuickPick<FolderItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.items = folders.map(folder => ({ label: folder.name, description: folder.uri.path, folder }));
	picker.ariaLabel = kind === 'file'
		? localize({ bundle: 'ash', key: 'workbench.newFileSelectFolder' }, 'Select a folder for the new file')
		: localize({ bundle: 'ash', key: 'files.newFolderSelectFolder' }, 'Select a folder for the new folder');
	picker.placeholder = picker.ariaLabel;
	return new Promise(resolve => {
		let settled = false;
		const finish = (folder: IWorkspaceFolder | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(folder);
			disposables.dispose();
		};
		disposables.add(picker.onDidAccept(item => finish(item.folder)));
		disposables.add(picker.onDidHide(() => finish(undefined)));
		picker.show();
	});
}
