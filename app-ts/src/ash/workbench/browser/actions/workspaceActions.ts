import { localize2 } from '../../../nls.js';

import { Keybinding, logicalKey } from '../../../base/common/keybindings.js';
import { Action2, MenuId, MenusRegistry } from '../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IsNativeContext } from '../../../platform/contextkey/common/contextkeys.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { BrowserLocalFolderSupportContext, OpenFolderWorkspaceSupportContext, WorkbenchStateContext } from '../../common/contextkeys.js';
import { IHostService } from '../../services/host/browser/host.js';
import { getWorkspaceRemoteAuthority, IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IWorkspaceOpenService } from '../../services/workspaces/browser/workspaceOpenService.js';

export const OpenFolderCommandId = 'workbench.action.files.openFolder';
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
		return accessor.get(IWorkspaceOpenService).openFolder();
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
		return accessor.get(IWorkspaceOpenService).openFolder();
	}
}
