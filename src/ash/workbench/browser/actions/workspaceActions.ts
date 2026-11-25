import { localize2 } from '../../../nls.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { basenameOrAuthority, extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceFolderLocationService, type IFolderLocation } from '../../../platform/workspace/common/folderLocations.js';

import { Keybinding, logicalKey } from '../../../base/common/keybindings.js';
import { Action2, MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IsNativeContext } from '../../../platform/contextkey/common/contextkeys.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { BrowserLocalFolderSupportContext, IsSessionsWindowContext, OpenFolderWorkspaceSupportContext, WorkbenchStateContext } from '../../common/contextkeys.js';
import { IHostService } from '../../services/host/browser/host.js';
import { getWorkspaceRemoteAuthority, IWorkspaceContextService, type IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { ADD_ROOT_FOLDER_COMMAND_ID, PICK_WORKSPACE_FOLDER_COMMAND_ID, SET_ROOT_FOLDER_COMMAND_ID } from './workspaceCommands.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IWorkspaceEditingService } from '../../services/workspaces/common/workspaceEditing.js';
import { EnterMultiRootWorkspaceSupportContext, WorkspaceFolderCountContext } from '../../common/contextkeys.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../nls.js';
import { status } from '../../../base/browser/ui/aria/aria.js';
import { IEditorService } from '../../services/editor/common/editorService.js';

export const OpenFolderCommandId = 'workbench.action.files.openFolder';

export class SwitchFolderLocationAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.switchFolderLocation',
			title: localize2('workspace.folderLocation.switch', 'Switch Folder Location'),
			f1: true,
			precondition: ContextKeyExpr.and(IsNativeContext.isEqualTo(true), IsSessionsWindowContext.isEqualTo(false), WorkbenchStateContext.isEqualTo('folder')),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IContextKeyService).getValue(IsSessionsWindowContext.key)) return;
		const context = accessor.get(IWorkspaceContextService);
		const locations = accessor.get(IWorkspaceFolderLocationService);
		const folder = context.getWorkspace().folders[0];
		if (!folder || !locations.canSetLocation(folder)) return;
		const editing = accessor.get(IWorkspaceEditingService);
		const quickInput = accessor.get(IQuickInputService);
		using picker = quickInput.createQuickPick<IQuickPickItem & IFolderLocation>();
		using request = new MutableDisposable<CancellationTokenSource>();
		using disposables = new DisposableStore();
		disposables.add(context.onDidChangeWorkspace(() => picker.hide()));
		const title = localize('workspace.folderLocation.switch', 'Switch Folder Location');
		picker.title = title;
		picker.ariaLabel = title;
		picker.placeholder = localize('workspace.folderLocation.placeholder', 'Select a folder location');
		picker.sortByLabel = false;
		const toItem = (location: IFolderLocation): IQuickPickItem & IFolderLocation => ({
			...location,
			description: location.description ?? location.uri.fsPath,
			picked: extUriBiasedIgnorePathCase.isEqual(location.uri, folder.uri),
		});
		const current = toItem(locations.getLocation(folder) ?? { uri: folder.uri, label: basenameOrAuthority(folder.uri) });
		picker.items = [current];

		const selected = new DeferredPromise<IFolderLocation | undefined>();
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (item) {
				void selected.complete(item);
				picker.hide();
			}
		}));
		disposables.add(picker.onDidHide(() => {
			request.value?.cancel();
			void selected.complete(undefined);
		}));
		const refresh = async (): Promise<void> => {
			if (selected.isSettled) {
				return;
			}
			request.value?.cancel();
			const pending = new CancellationTokenSource();
			request.value = pending;
			picker.busy = true;
			try {
				const known = await locations.getFolderLocations(folder, pending.token);
				if (pending.token.isCancellationRequested) {
					return;
				}
				const active = picker.activeItems[0];
				const items = known.map(toItem);
				const currentItem = items.find(item => item.picked) ?? current;
				if (currentItem === current) {
					// Discovery can omit the directory the window is still using.
					items.push(current);
				}
				const next = active && items.find(item => extUriBiasedIgnorePathCase.isEqual(item.uri, active.uri));
				picker.items = items;
				picker.activeItems = [next ?? currentItem];
			} catch (error) {
				if (!pending.token.isCancellationRequested) {
					void selected.error(error);
					picker.hide();
				}
			} finally {
				if (!pending.token.isCancellationRequested) {
					picker.busy = false;
				}
			}
		};
		disposables.add(Event.any(locations.onDidChangeProviders, locations.onDidChangeLocations)(refresh));
		picker.show();
		void refresh();
		try {
			const selection = await selected.p;
			if (selection) await editing.setFolderLocation(selection.uri, { folder: folder.uri, reason: 'user' });
		} catch (error) {
			if (!isCancellationError(error)) throw error;
		}
	}
}

export class OpenWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openWorkspace', title: localize2('workspace.openFile', 'Open Workspace from File...'), f1: true,
			precondition: EnterMultiRootWorkspaceSupportContext.isEqualTo(true),
			menu: { id: MenuId.MenubarFileMenu, when: EnterMultiRootWorkspaceSupportContext.isEqualTo(true), group: '2_open', order: 3 }
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IFileDialogService).pickWorkspaceAndOpen();
	}
}

export class OpenWorkspaceConfigFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openWorkspaceConfigFile', title: localize2('workspace.openConfiguration', 'Open Workspace Configuration File'), f1: true,
			precondition: ContextKeyExpr.and(EnterMultiRootWorkspaceSupportContext.isEqualTo(true), WorkbenchStateContext.isEqualTo('workspace'))
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const resource = accessor.get(IWorkspaceContextService).getWorkspace().configuration;
		if (resource) await accessor.get(IEditorService).openEditor({ resource }, { pinned: true });
	}
}

export class AddRootFolderAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.addRootFolder', title: localize2('workspace.addFolder', 'Add Folder to Workspace...'), f1: true,
			precondition: EnterMultiRootWorkspaceSupportContext.isEqualTo(true),
			menu: { id: MenuId.MenubarFileMenu, when: EnterMultiRootWorkspaceSupportContext.isEqualTo(true), group: '2_open', order: 4 }
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(ADD_ROOT_FOLDER_COMMAND_ID);
	}
}

export class RemoveRootFolderAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.removeRootFolder', title: localize2('workspace.removeFolder', 'Remove Folder from Workspace...'), f1: true,
			precondition: ContextKeyExpr.and(EnterMultiRootWorkspaceSupportContext.isEqualTo(true), ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0)),
			menu: { id: MenuId.MenubarFileMenu, when: ContextKeyExpr.and(EnterMultiRootWorkspaceSupportContext.isEqualTo(true), ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0)), group: '2_open', order: 5 }
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const folder = await accessor.get(ICommandService).executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [{ placeHolder: localize('workspace.removeFolder', 'Remove Folder from Workspace...') }]);
		if (!folder) return;
		await accessor.get(IWorkspaceEditingService).removeFolders([folder.uri]);
		status(localize('workspace.foldersUpdated', 'Workspace folders updated.'));
	}
}

export class SaveWorkspaceAsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.saveWorkspaceAs', title: localize2('workspace.saveAs', 'Save Workspace As...'), f1: true,
			precondition: EnterMultiRootWorkspaceSupportContext.isEqualTo(true),
			menu: { id: MenuId.MenubarFileMenu, when: EnterMultiRootWorkspaceSupportContext.isEqualTo(true), group: '2_open', order: 6 }
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const editing = accessor.get(IWorkspaceEditingService);
		const target = await editing.pickNewWorkspacePath();
		if (!target) return;
		await editing.saveAndEnterWorkspace(target);
		status(localize('workspace.saved', 'Workspace saved.'));
	}
}
const OpenFolderViaWorkspaceWhen = ContextKeyExpr.and(
	OpenFolderWorkspaceSupportContext.isEqualTo(false),
	BrowserLocalFolderSupportContext.isEqualTo(true),
);
const EmptyWorkspaceSupport = ContextKeyExpr.or(IsNativeContext.isEqualTo(true), BrowserLocalFolderSupportContext.isEqualTo(true));
const CloseWorkspacePrecondition = ContextKeyExpr.and(EmptyWorkspaceSupport, ContextKeyExpr.notEquals(WorkbenchStateContext.key, 'empty'));

export class CloseWorkspaceAction extends Action2 {
	static readonly ID = 'workbench.action.closeFolder';

	constructor() {
		super({
			id: CloseWorkspaceAction.ID,
			title: localize2({ bundle: 'ash', key: 'workbench.closeWorkspace' }, 'Close Workspace'),
			f1: true,
			precondition: CloseWorkspacePrecondition,
			keybinding: { primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('f')) },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const remoteAuthority = getWorkspaceRemoteAuthority(accessor.get(IWorkspaceContextService).getWorkspace());
		return accessor.get(IHostService).openWindow({ forceReuseWindow: true, ...(remoteAuthority ? { remoteAuthority } : {}) });
	}
}

MenusRegistry.appendMenuItems([
	{
		id: MenuId.MenubarFileMenu,
		item: {
			command: { id: CloseWorkspaceAction.ID, title: localize2({ bundle: 'ash', key: 'workbench.closeFolder' }, 'Close Folder'), precondition: CloseWorkspacePrecondition },
			when: ContextKeyExpr.and(EmptyWorkspaceSupport, WorkbenchStateContext.isEqualTo('folder')),
			group: '6_close',
			order: 3,
		},
	},
	{
		id: MenuId.MenubarFileMenu,
		item: {
			command: { id: CloseWorkspaceAction.ID, title: localize2({ bundle: 'ash', key: 'workbench.closeWorkspace' }, 'Close Workspace'), precondition: CloseWorkspacePrecondition },
			when: ContextKeyExpr.and(EmptyWorkspaceSupport, WorkbenchStateContext.isEqualTo('workspace')),
			group: '6_close',
			order: 3,
		},
	},
]);

/** Opens a folder through the current Workbench host. */
export class OpenFolderAction extends Action2 {
	constructor() {
		super({
			id: OpenFolderCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.openFolder' }, 'Open Folder...'),
			f1: true,
			precondition: OpenFolderWorkspaceSupportContext.isEqualTo(true),
			menu: { id: MenuId.MenubarFileMenu, when: OpenFolderWorkspaceSupportContext.isEqualTo(true), group: '2_open', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IFileDialogService).pickFolderAndOpen();
	}
}

/** Replaces the folder in a browser workspace backed by a local directory handle. */
export class OpenFolderViaWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.files.openFolderViaWorkspace',
			title: localize2({ bundle: 'ash', key: 'workbench.openFolder' }, 'Open Folder...'),
			f1: true,
			precondition: OpenFolderViaWorkspaceWhen,
			menu: { id: MenuId.MenubarFileMenu, when: OpenFolderViaWorkspaceWhen, group: '2_open', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ICommandService).executeCommand<void>(SET_ROOT_FOLDER_COMMAND_ID);
	}
}
