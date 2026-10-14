import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ASH_REMOTE_SCHEME, getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService, getWorkspaceRemoteAuthority } from '../../../../platform/workspace/common/workspace.js';
import {
	DEVELOPMENT_DIR_PERMISSIONS,
	IWorkspaceTrustApi,
	READ_DIR_PERMISSIONS,
	type IWorkspaceTrustInfo,
	type IWorkspaceTrustManagementService,
	type IWorkspaceTrustUriInfo,
	type WorkspaceTrustPermission,
} from '../../../../platform/workspace/common/workspaceTrust.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';

/** Derives the UI trust view from Rust's effective capabilities on every read. */
export class WorkspaceTrustManagementService extends Disposable implements IWorkspaceTrustManagementService {
	private readonly change = this._register(new Emitter<void>());
	public readonly onDidChangeTrust = this.change.event;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustApi private readonly trust: IWorkspaceTrustApi,
		@IRemoteAuthorityResolverService private readonly resolver: IRemoteAuthorityResolverService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.change.fire()));
		this._register(trust.onDidChangeTrust(() => this.change.fire()));
		this._register(resolver.onDidChangeConnectionData(() => this.change.fire()));
	}

	public async getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo> {
		const remote = isRemoteResource(uri);
		if (!remote && uri.scheme !== 'file') { return { uri, trusted: false, permissions: undefined }; }
		const connected = remote && this.resolver.getConnectionData(uri.authority);
		const resolved = connected ? await this.resolver.resolveAuthority(uri.authority) : undefined;
		const canonical = connected ? await this.resolver.getCanonicalURI(uri) : uri;
		// Resolver identities may narrow access, but cannot redirect a grant to another host or a local path.
		if (remote && (canonical.scheme !== uri.scheme || canonical.authority !== uri.authority)) {
			return { uri, trusted: false, permissions: undefined };
		}
		const path = remote ? getRemoteWorkspacePath(canonical.with({ query: null, fragment: null })) : canonical.fsPath;
		const { permissions } = await this.trust.readDirectory(path);
		return { uri: canonical, trusted: resolved?.options?.isTrusted !== false && hasDevelopmentPermissions(permissions), permissions };
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
		const trustInfo = await Promise.all(folders.map(folder => this.getUriTrustInfo(folder.uri)));
		const permissions = trustInfo.map(info => info.permissions);
		if (permissions.some(allowed => allowed === undefined)) return undefined;
		return {
			// A resolver may restrict trust; only Rust's actual capabilities authorize development.
			isTrusted: resolved?.options?.isTrusted !== false && trustInfo.every(info => info.trusted),
			isReadOnly: permissions.every(allowed => allowed !== undefined
				&& READ_DIR_PERMISSIONS.every(permission => allowed.includes(permission))
				&& allowed.every(permission => READ_DIR_PERMISSIONS.includes(permission))),
		};
	}
}

function hasDevelopmentPermissions(allowed: readonly WorkspaceTrustPermission[] | undefined): boolean {
	return allowed !== undefined && DEVELOPMENT_DIR_PERMISSIONS.every(permission => allowed.includes(permission));
}
