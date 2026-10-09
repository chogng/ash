import { isValidBasename } from '../../../../base/common/extpath.js';
import { posix, win32, type IPath } from '../../../../base/common/path.js';
import { Schemas } from '../../../../base/common/network.js';
import { operatingSystem, OperatingSystem } from '../../../../base/common/platform.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IRendererHostService, type IRendererHost } from '../../../../platform/renderer/common/rendererHost.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Reads connection-owned host facts without caching a second copy of them. */
export class BrowserPathService implements IPathService {
	constructor(
		@IRendererHostService private readonly host: IRendererHost,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { }

	public get path(): Promise<IPath> {
		const os = this.hostOperatingSystem;
		return os === undefined ? Promise.reject(new Error('App Server path platform is unavailable')) : Promise.resolve(os === OperatingSystem.Windows ? win32 : posix);
	}

	public get resolvedUserHome(): URI | undefined {
		const path = this.host.appServer.userHome;
		if (!this.host.hasAppServer) {
			return this.host.localUserHome;
		}
		return path === undefined ? undefined : this.toFileURI(path);
	}

	public userHome(options: { preferLocal: true; }): URI;
	public userHome(options?: { preferLocal: boolean; }): Promise<URI>;
	public userHome(options?: { preferLocal: boolean; }): URI | Promise<URI> {
		if (options?.preferLocal || !this.host.hasAppServer) {
			const workspace = this.workspace.getWorkspace();
			// Web has no OS home: match VS Code's workspace-derived fallback for dialog callers.
			const local = this.host.localUserHome ?? workspace.folders[0]?.uri ?? (workspace.configuration ? dirname(workspace.configuration) : URI.from({ scheme: Schemas.file, path: '/' }));
			return options?.preferLocal ? local : Promise.resolve(local);
		}
		const home = this.resolvedUserHome;
		return home ? Promise.resolve(home) : Promise.reject(new Error('App Server user home is unavailable'));
	}

	public async getPath(resource: URI): Promise<IPath | undefined> {
		if (resource.scheme === Schemas.ashRemote || resource.scheme === Schemas.file && resource.path.startsWith('/@browser/')) {
			return posix;
		}
		return resource.scheme !== Schemas.file || this.hostOperatingSystem === undefined ? undefined : this.path;
	}

	public async fileURI(path: string): Promise<URI> {
		return this.toFileURI(path);
	}

	private toFileURI(path: string): URI {
		const os = this.hostOperatingSystem;
		// Older servers may omit OS facts. Only explicit drive/UNC syntax identifies Windows then.
		const windowsPath = os === OperatingSystem.Windows || os === undefined && (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\'));
		const normalized = windowsPath ? path.replaceAll('\\', '/') : path;
		if (!normalized.startsWith('/') && !(windowsPath && /^[a-z]:\//i.test(normalized))) {
			throw new TypeError('File path must be absolute');
		}
		const share = /^\/\/([^/]+)(\/.*)?$/.exec(normalized);
		return URI.from({ scheme: Schemas.file, authority: share?.[1] ?? '', path: share ? share[2] ?? '/' : normalized });
	}

	public async getOperatingSystem(resource: URI): Promise<OperatingSystem | undefined> {
		return resource.scheme === Schemas.file && !resource.path.startsWith('/@browser/') ? this.hostOperatingSystem : undefined;
	}

	private get hostOperatingSystem(): OperatingSystem | undefined {
		return this.host.hasAppServer ? this.host.appServer.operatingSystem : operatingSystem;
	}

	public async hasValidBasename(resource: URI, name: string = basename(resource)): Promise<boolean> {
		return this.validateName(resource, name, await this.getOperatingSystem(resource));
	}

	private validateName(resource: URI, name: string, os: OperatingSystem | undefined): boolean {
		if (resource.scheme === Schemas.ashRemote) {
			// SSH resources currently have a POSIX contract; this does not identify a particular OS.
			return isValidBasename(name, false);
		}
		if (resource.scheme === Schemas.file && resource.path.startsWith('/@browser/')) {
			// FileSystemHandle names forbid both separators, including inside browser-owned storage.
			return isValidBasename(name, false) && !name.includes('\\');
		}
		if (resource.scheme !== Schemas.file) {
			return isValidBasename(name, false);
		}
		// An uninitialized backend has no known path rules. Accept only portable disk names until ready.
		return isValidBasename(name, os === undefined || os === OperatingSystem.Windows);
	}
}

registerSingleton(IPathService, BrowserPathService, InstantiationType.Delayed);
