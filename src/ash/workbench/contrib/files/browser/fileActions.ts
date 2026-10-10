import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { ISystemFileTransferService } from '../../../../platform/files/common/systemFileTransferService.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExplorerService } from './files.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

// Command registration lives in fileActions.contribution.ts. Download is implemented there by FileDownload.
export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const NEW_FOLDER_COMMAND_ID = 'explorer.newFolder';
export const DOWNLOAD_COMMAND_ID = 'explorer.download';
export const RENAME_FILE_COMMAND_ID = 'renameFile';
export const DELETE_FILE_COMMAND_ID = 'deleteFile';
export const OPEN_TO_SIDE_COMMAND_ID = 'explorer.openToSide';
export const CUT_FILE_COMMAND_ID = 'filesExplorer.cut';
export const COPY_FILE_COMMAND_ID = 'filesExplorer.copy';
export const PASTE_FILE_COMMAND_ID = 'filesExplorer.paste';
export const CANCEL_CUT_COMMAND_ID = 'filesExplorer.cancelCut';

/** Handles {@link COPY_FILE_COMMAND_ID} and {@link CUT_FILE_COMMAND_ID}; roots and nested selections are omitted. */
export async function copyExplorerItems(accessor: ServicesAccessor, cut: boolean): Promise<void> {
	const selection = accessor.get(IExplorerService).getContext();
	const items = selection.filter(item => !isWorkspaceRoot(accessor, item.resource) && !selection.some(parent =>
		parent !== item && parent.kind === FileKind.Directory && extUriBiasedIgnorePathCase.isEqualOrParent(item.resource, parent.resource)));
	if (!items.length) return;
	await accessor.get(IClipboardService).writeResources(items.map(item => item.resource), cut ? 'move' : 'copy');
	accessor.get(IExplorerService).setToCopy(items, cut);
}

/** Handles {@link CANCEL_CUT_COMMAND_ID} without clearing clipboard content written after the cut. */
export async function cancelExplorerCut(accessor: ServicesAccessor): Promise<void> {
	const explorer = accessor.get(IExplorerService);
	if (!explorer.getToCopy().cut) return;
	const { resources, operation } = await accessor.get(IClipboardService).readResources();
	if (operation === 'move' && sameResources(resources, explorer.getToCopy().items.map(item => item.resource))) {
		await accessor.get(IClipboardService).writeResources([], 'copy');
	}
	explorer.setToCopy([], false);
}

/** Handles {@link PASTE_FILE_COMMAND_ID}; Ash resources retain cut semantics when the OS also supplies files. */
export async function pasteExplorerItems(accessor: ServicesAccessor, fileList?: unknown, moveRequested?: unknown): Promise<void> {
	if (fileList !== undefined && !(fileList instanceof FileList)) throw new TypeError('Invalid files to paste');
	if (moveRequested !== undefined && typeof moveRequested !== 'boolean') throw new TypeError('Invalid system paste operation');
	const move = moveRequested === true;
	const explorer = accessor.get(IExplorerService);
	const clipboard = accessor.get(IClipboardService);
	const { resources, operation } = await clipboard.readResources();
	const nativeFiles = resources.length === 0 && fileList && fileList.length > 0 ? [...fileList] : [];
	const localClipboard = explorer.getToCopy();
	const cut = nativeFiles.length === 0 && (operation === 'move' || move);
	const selection = explorer.getContext()[0];
	const workspaceContext = accessor.get(IWorkspaceContextService);
	const directory = selection && selection.resource.scheme !== 'ash-workspace'
		? selection.kind === FileKind.Directory ? selection.resource : dirname(selection.resource)
		: await resolveCreationDirectory(accessor, 'folder');
	if (!directory) return;
	const files = accessor.get(IFileService);
	const paths = accessor.get(IPathService);
	if (!resources.length && await accessor.get(ISystemFileTransferService).pasteSystemFiles(directory, move)) {
		explorer.setToCopy([], false);
		status(localize('accessibility.explorerSystemFilesPasted', 'Files pasted into the selected folder.'));
		return;
	}
	if (move && !resources.length) return;
	if (!nativeFiles.length && !resources.length) return;
	for (const file of nativeFiles) {
		if (!await paths.hasValidBasename(directory, file.name)) continue;
		const target = await availablePasteTarget(files, directory, file.name);
		await files.writeFileBytes(target, new Uint8Array(await file.arrayBuffer()));
	}
	for (const resource of resources) {
		const local = localClipboard.items.find(item => extUriBiasedIgnorePathCase.isEqual(item.resource, resource));
		const kind = local?.kind ?? (await files.stat(resource)).kind;
		const name = local?.name ?? basename(resource);
		if (!await paths.hasValidBasename(directory, name)) continue;
		if (kind === FileKind.Directory && extUriBiasedIgnorePathCase.isEqualOrParent(directory, resource)) {
			throw new Error(localize({ bundle: 'ash', key: 'files.pasteIntoSelf' }, 'Cannot paste a folder into itself.'));
		}
		const desired = directory.joinPathSegment(name);
		if (cut && extUriBiasedIgnorePathCase.isEqual(desired, resource)) continue;
		const target = await availablePasteTarget(files, directory, name);
		const sourceFolder = workspaceContext.getWorkspaceFolder(resource);
		if (cut && sourceFolder && sourceFolder.id === workspaceContext.getWorkspaceFolder(target)?.id) {
			await files.rename(resource, target, 'error');
		} else {
			await files.copy(resource, target);
			if (cut) await files.delete(resource, 'error', 'recursive');
		}
	}
	if (cut) {
		await accessor.get(IClipboardService).writeResources([], 'copy');
		explorer.setToCopy([], false);
	}
}

/** Matches the ordered clipboard resources so a later write cannot inherit an earlier cut. */
function sameResources(left: readonly URI[], right: readonly URI[]): boolean {
	return left.length === right.length && left.every((resource, index) => extUriBiasedIgnorePathCase.isEqual(resource, right[index]));
}

/** Never overwrites a paste target; name conflicts receive ` copy`, then ` copy 2`, and so on. */
async function availablePasteTarget(files: IFileService, directory: URI, name: string): Promise<URI> {
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';
	for (let index = 0; index < 10_000; index++) {
		const candidate = directory.joinPathSegment(index === 0 ? name : `${stem} copy${index === 1 ? '' : ` ${index}`}${extension}`);
		try { await files.stat(candidate); }
		catch (error) { if (error instanceof FileNotFoundError) return candidate; throw error; }
	}
	throw new Error(localize({ bundle: 'ash', key: 'files.pasteNoName' }, 'Could not find an available file name.'));
}

/** Handles {@link RENAME_FILE_COMMAND_ID} for the selected non-root item. */
export async function renameExplorerItem(accessor: ServicesAccessor): Promise<void> {
	const item = accessor.get(IExplorerService).getContext()[0];
	if (!item || isWorkspaceRoot(accessor, item.resource)) return;
	const paths = accessor.get(IPathService);
	const name = await accessor.get(IQuickInputService).input({
		title: localize({ bundle: 'ash', key: 'files.rename' }, 'Rename'),
		value: item.name,
		validateInput: async value => await paths.hasValidBasename(item.resource, value)
			? undefined
			: localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a valid file name for the target file system.'),
	});
	if (name === undefined || name === item.name) return;
	if (!await paths.hasValidBasename(item.resource, name)) throw new Error(localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a valid file name for the target file system.'));
	await accessor.get(IFileService).rename(item.resource, dirname(item.resource).joinPathSegment(name), 'error');
}

/** Handles {@link DELETE_FILE_COMMAND_ID} with confirmation before permanent deletion. */
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

/** Handles {@link OPEN_TO_SIDE_COMMAND_ID} for a selected file. */
export async function openExplorerItemToSide(accessor: ServicesAccessor): Promise<void> {
	const item = accessor.get(IExplorerService).getContext()[0];
	if (item?.kind === FileKind.File) {
		await accessor.get(IEditorService).openEditor(new FileEditorInput(item.resource, { label: item.name }), { pinned: true }, 'sideGroup');
	}
}

function isWorkspaceRoot(accessor: ServicesAccessor, resource: URI): boolean {
	if (resource.scheme === 'ash-workspace') return true;
	const folder = accessor.get(IWorkspaceContextService).getWorkspaceFolder(resource);
	return !!folder && extUriBiasedIgnorePathCase.isEqual(folder.uri, resource);
}

/** Handles {@link NEW_FILE_COMMAND_ID}; creates a file in the chosen folder and opens it in the editor. */
export async function createNewFile(accessor: ServicesAccessor): Promise<void> {
	const directory = await resolveCreationDirectory(accessor, 'file');
	if (!directory) return;
	const paths = accessor.get(IPathService);
	const name = await accessor.get(IQuickInputService).input({
		title: localize({ bundle: 'ash', key: 'workbench.newFileName' }, 'New File Name'),
		placeHolder: localize({ bundle: 'ash', key: 'workbench.newFileNamePlaceholder' }, 'Enter a file name'),
		validateInput: async value => await paths.hasValidBasename(directory, value)
			? undefined
			: localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a valid file name for the target file system.'),
	});
	if (name === undefined) return;
	if (!await paths.hasValidBasename(directory, name)) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.newFileInvalidName' }, 'Enter a valid file name for the target file system.'));
	}
	const resource = directory.joinPathSegment(name);
	await accessor.get(IFileService).createFile(resource, 'error');
	await accessor.get(IEditorService).openEditor(new FileEditorInput(resource, { label: name }));
}

/** Handles {@link NEW_FOLDER_COMMAND_ID} in the selected or active workspace folder. */
export async function createNewFolder(accessor: ServicesAccessor): Promise<void> {
	const directory = await resolveCreationDirectory(accessor, 'folder');
	if (!directory) return;
	const paths = accessor.get(IPathService);
	const name = await accessor.get(IQuickInputService).input({
		title: localize({ bundle: 'ash', key: 'files.newFolderName' }, 'New Folder Name'),
		placeHolder: localize({ bundle: 'ash', key: 'files.newFolderPlaceholder' }, 'Enter a folder name'),
		validateInput: async value => await paths.hasValidBasename(directory, value)
			? undefined
			: localize({ bundle: 'ash', key: 'files.invalidName' }, 'Enter a valid name for the target file system.'),
	});
	if (name === undefined) return;
	if (!await paths.hasValidBasename(directory, name)) throw new Error(localize({ bundle: 'ash', key: 'files.invalidName' }, 'Enter a valid name for the target file system.'));
	await accessor.get(IFileService).createDirectory(directory.joinPathSegment(name));
}

/** Uses the selected item's directory, then the active editor's workspace root; prompts if roots are ambiguous. */
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
		: selection ? dirname(selection.resource) : undefined;
	const selectedDirectory = selectionDirectory && accessor.get(IWorkspaceContextService).getWorkspaceFolder(selectionDirectory)
		? selectionDirectory
		: undefined;
	const activeResource = accessor.get(IEditorService).activeEditor?.resource;
	const activeFolder = activeResource ? accessor.get(IWorkspaceContextService).getWorkspaceFolder(activeResource) : null;
	const folder = selectedDirectory ? undefined : activeFolder ?? (workspace.folders.length === 1
		? workspace.folders[0]
		: await pickWorkspaceFolder(quickInput, workspace.folders, kind));
	return selectedDirectory ?? folder?.uri;
}

function pickWorkspaceFolder(quickInput: IQuickInputService, folders: readonly IWorkspaceFolder[], kind: 'file' | 'folder'): Promise<IWorkspaceFolder | undefined> {
	type FolderItem = IQuickPickItem & { readonly folder: IWorkspaceFolder; };
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
