import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IDirPermissionsService, type DirPermission } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type IWorkspaceTrustInfo, type IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';

/** Derives the UI trust view from Rust's effective capabilities on every read. */
export class WorkspaceTrustManagementService extends Disposable implements IWorkspaceTrustManagementService {
	private readonly change = this._register(new Emitter<void>());
	public readonly onDidChangeTrust = this.change.event;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IDirPermissionsService private readonly permissions: IDirPermissionsService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.change.fire()));
		this._register(permissions.onDidChangePermissions(() => this.change.fire()));
	}

	public async getWorkspaceTrustInfo(): Promise<IWorkspaceTrustInfo | undefined> {
		const folders = this.workspace.getWorkspace().folders;
		if (folders.length === 0) return undefined;
		const permissions = await Promise.all(folders.map(folder => {
			const path = isRemoteResource(folder.uri) ? getRemoteWorkspacePath(folder.uri) : folder.uri.fsPath;
			return this.permissions.read(path);
		}));
		if (permissions.some(allowed => allowed === undefined)) return undefined;
		return {
			isTrusted: permissions.every(allowed => hasDevelopmentPermissions(allowed)),
			isReadOnly: permissions.every(allowed => allowed !== undefined
				&& READ_DIR_PERMISSIONS.every(permission => allowed.includes(permission))
				&& allowed.every(permission => READ_DIR_PERMISSIONS.includes(permission))),
		};
	}
}

function hasDevelopmentPermissions(allowed: readonly DirPermission[] | undefined): boolean {
	return allowed !== undefined && DEVELOPMENT_DIR_PERMISSIONS.every(permission => allowed.includes(permission));
}
