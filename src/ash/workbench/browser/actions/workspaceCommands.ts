import { status } from '../../../base/browser/ui/aria/aria.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../services/workspaces/common/workspaceEditing.js';

export const ADD_ROOT_FOLDER_COMMAND_ID = 'addRootFolder';
export const SET_ROOT_FOLDER_COMMAND_ID = 'setRootFolder';
export const PICK_WORKSPACE_FOLDER_COMMAND_ID = '_workbench.pickWorkspaceFolder';

CommandsRegistry.register(ADD_ROOT_FOLDER_COMMAND_ID, async accessor => {
	const workspace = accessor.get(IWorkspaceContextService);
	const current = workspace.getWorkspace();
	const folders = await accessor.get(IFileDialogService).showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: true,
		title: localize('workspace.addFolder', 'Add Folder to Workspace...'),
	});
	// A dialog belongs to the workspace in which it was opened.
	if (!folders?.length || current !== workspace.getWorkspace()) return;
	await accessor.get(IWorkspaceEditingService).addFolders(folders.map(uri => ({ uri })));
	status(localize('workspace.foldersUpdated', 'Workspace folders updated.'));
});

CommandsRegistry.register(SET_ROOT_FOLDER_COMMAND_ID, async accessor => {
	const context = accessor.get(IWorkspaceContextService);
	const current = context.getWorkspace();
	const folders = await accessor.get(IFileDialogService).showOpenDialog({ canSelectFiles: false, canSelectFolders: true });
	if (!folders?.length || current !== context.getWorkspace()) return;
	await accessor.get(IWorkspaceEditingService).updateFolders(0, current.folders.length, folders.map(uri => ({ uri })));
});

CommandsRegistry.register(PICK_WORKSPACE_FOLDER_COMMAND_ID, async (accessor, args) => {
	if (args !== undefined && (!Array.isArray(args) || args.length > 2)) throw new TypeError('Invalid workspace picker arguments');
	const [options, token = CancellationToken.None] = (args ?? []) as readonly unknown[];
	if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new TypeError('Invalid workspace picker options');
	const placeHolder = (options as { placeHolder?: unknown; } | undefined)?.placeHolder;
	if (placeHolder !== undefined && typeof placeHolder !== 'string') throw new TypeError('Invalid workspace picker placeholder');
	if (!CancellationToken.isCancellationToken(token)) throw new TypeError('Invalid workspace picker cancellation token');
	if (token.isCancellationRequested) return undefined;
	const workspace = accessor.get(IWorkspaceContextService);
	const current = workspace.getWorkspace();
	if (!current.folders.length) return undefined;
	const lifetime = new DisposableStore();
	const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<{ label: string; description: string; folder: IWorkspaceFolder; }>());
	picker.items = current.folders.map(folder => ({
		label: folder.name,
		description: folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.path,
		folder,
	}));
	picker.ariaLabel = picker.placeholder = placeHolder ?? localize('workspace.selectFolder', 'Select a workspace folder');
	return new Promise<IWorkspaceFolder | undefined>(resolve => {
		let result: IWorkspaceFolder | undefined;
		lifetime.add(toDisposable(() => resolve(result)));
		lifetime.add(picker.onDidAccept(() => {
			result = picker.selectedItems[0]?.folder;
			if (result) picker.hide();
		}));
		lifetime.add(picker.onDidHide(() => lifetime.dispose()));
		const cancel = () => { result = undefined; picker.hide(); lifetime.dispose(); };
		lifetime.add(token.onCancellationRequested(cancel));
		// Never hand a caller a root from an obsolete permission/execution scope.
		lifetime.add(workspace.onDidChangeWorkspace(cancel));
		picker.show();
	});
});
