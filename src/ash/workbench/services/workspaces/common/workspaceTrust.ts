import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ASH_REMOTE_SCHEME, getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IDirPermissionsService, type DirPermission } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IWorkspaceContextService, getWorkspaceRemoteAuthority } from '../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type IWorkspaceTrustInfo, type IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';

/** Derives the UI trust view from Rust's effective capabilities on every read. */
export class WorkspaceTrustManagementService extends Disposable implements IWorkspaceTrustManagementService {
	private readonly change = this._register(new Emitter<void>());
	public readonly onDidChangeTrust = this.change.event;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IDirPermissionsService private readonly permissions: IDirPermissionsService,
		@IRemoteAuthorityResolverService private readonly resolver: IRemoteAuthorityResolverService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.change.fire()));
		this._register(permissions.onDidChangePermissions(() => this.change.fire()));
		this._register(resolver.onDidChangeConnectionData(() => this.change.fire()));
	}

	public async getWorkspaceTrustInfo(): Promise<IWorkspaceTrustInfo | undefined> {
		const workspace = this.workspace.getWorkspace();
		const authority = getWorkspaceRemoteAuthority(workspace);
		const resolved = authority && this.resolver.getConnectionData(authority) ? await this.resolver.resolveAuthority(authority) : undefined;
		const folders = workspace.folders;
		if (folders.length === 0) {
			if (!authority || resolved?.options?.isTrusted === undefined) { return undefined; }
			// This URI identifies the remote namespace; it is never used to grant or read the filesystem root.
			const canonical = await this.resolver.getCanonicalURI(URI.from({ scheme: ASH_REMOTE_SCHEME, authority, path: '/' }));
			const sameHost = canonical.scheme === ASH_REMOTE_SCHEME && canonical.authority === authority;
			return { isTrusted: sameHost && resolved.options.isTrusted, isReadOnly: false };
		}
		const permissions = await Promise.all(folders.map(async folder => {
			const remote = isRemoteResource(folder.uri);
			const canonical = remote && this.resolver.getConnectionData(folder.uri.authority) ? await this.resolver.getCanonicalURI(folder.uri) : folder.uri;
			// Canonical identities cannot redirect a directory grant into another host or the local filesystem.
			if (remote && (canonical.scheme !== folder.uri.scheme || canonical.authority !== folder.uri.authority)) { return undefined; }
			const path = remote ? getRemoteWorkspacePath(canonical.with({ query: null, fragment: null })) : canonical.fsPath;
			return this.permissions.read(path);
		}));
		if (permissions.some(allowed => allowed === undefined)) return undefined;
		return {
			// A resolver may restrict trust; only Rust's actual capabilities authorize development.
			isTrusted: resolved?.options?.isTrusted !== false && permissions.every(allowed => hasDevelopmentPermissions(allowed)),
			isReadOnly: permissions.every(allowed => allowed !== undefined
				&& READ_DIR_PERMISSIONS.every(permission => allowed.includes(permission))
				&& allowed.every(permission => READ_DIR_PERMISSIONS.includes(permission))),
		};
	}
}

function hasDevelopmentPermissions(allowed: readonly DirPermission[] | undefined): boolean {
	return allowed !== undefined && DEVELOPMENT_DIR_PERMISSIONS.every(permission => allowed.includes(permission));
}
