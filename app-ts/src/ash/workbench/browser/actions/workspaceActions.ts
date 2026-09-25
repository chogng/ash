import { localizedString } from '../../../platform/action/common/action.js';
import { Action2, MenuId } from '../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { BrowserLocalFolderSupportContext, OpenFolderWorkspaceSupportContext } from '../../common/contextkeys.js';
import { IWorkspaceOpenService } from '../../services/workspaces/browser/workspaceOpenService.js';

export const OpenFolderCommandId = 'workbench.action.files.openFolder';
const OpenFolderViaWorkspaceWhen = ContextKeyExpr.and(
	OpenFolderWorkspaceSupportContext.isEqualTo(false),
	BrowserLocalFolderSupportContext.isEqualTo(true),
);

/** Opens a folder through the current Workbench host. */
export class OpenFolderAction extends Action2 {
	constructor() {
		super({
			id: OpenFolderCommandId,
			title: localizedString('ash', 'workbench.openFolder', 'Open Folder...'),
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
			title: localizedString('ash', 'workbench.openFolder', 'Open Folder...'),
			f1: true,
			precondition: OpenFolderViaWorkspaceWhen,
			menu: { id: MenuId.MenubarFileMenu, when: OpenFolderViaWorkspaceWhen, group: '2_open', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IWorkspaceOpenService).openFolder();
	}
}
