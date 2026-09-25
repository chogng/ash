import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExplorerService } from './files.js';
import { FileEditorInput } from './editors/fileEditorInput.js';

export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const DOWNLOAD_COMMAND_ID = 'explorer.download';

/** Creates a file in the selected Explorer folder and opens it in the editor. */
export async function createNewFile(accessor: ServicesAccessor): Promise<void> {
	const workspace = accessor.get(IWorkspaceContextService).getWorkspace();
	if (workspace.folders.length === 0) {
		throw new Error(localize({ bundle: 'ash', key: 'workbench.newFileNoFolder' }, 'Open a folder to create a file.'));
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
		: await pickWorkspaceFolder(quickInput, workspace.folders));
	const directory = selectedDirectory ?? folder?.uri;
	if (!directory) return;

	const name = await quickInput.input({
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

function validFileName(value: string): boolean {
	return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f]/.test(value);
}

function pickWorkspaceFolder(quickInput: IQuickInputService, folders: readonly IWorkspaceFolder[]): Promise<IWorkspaceFolder | undefined> {
	type FolderItem = IQuickPickItem & { readonly folder: IWorkspaceFolder };
	const picker = quickInput.createQuickPick<FolderItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.items = folders.map(folder => ({ label: folder.name, description: folder.uri.path, folder }));
	picker.ariaLabel = localize({ bundle: 'ash', key: 'workbench.newFileSelectFolder' }, 'Select a folder for the new file');
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
