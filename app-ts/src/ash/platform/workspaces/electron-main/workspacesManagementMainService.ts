import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { parseJsonc } from '../../../base/common/jsonc.js';
import { URI } from '../../../base/common/uri.js';
import { type IAnyWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier, type IWorkspace, type IWorkspaceFolder, workspaceFromIdentifier } from '../../workspace/common/workspace.js';
import { parseStoredWorkspaceFolders } from '../common/workspaces.js';
import { getSingleFolderWorkspaceIdentifier, nodeWorkspacePathService, stableWorkspaceId, type IWorkspacePathService, WorkspacePathKind } from '../node/workspaces.js';

/** Resolves workspace files and canonical folder identities for desktop windows. */
export class WorkspacesManagementMainService {
	constructor(private readonly pathService: IWorkspacePathService = nodeWorkspacePathService) {}

	public async resolveFolder(path: string): Promise<ISingleFolderWorkspaceIdentifier> {
		const folder = await this.pathService.resolvePath(resolve(path));
		if (folder.kind !== WorkspacePathKind.Directory) {
			throw new Error(`Workspace folder is not a directory: ${path}`);
		}
		return getSingleFolderWorkspaceIdentifier(URI.file(folder.path));
	}

	public async resolveWorkspace(identifier: IAnyWorkspaceIdentifier): Promise<IWorkspace> {
		if (!('configPath' in identifier)) {
			return workspaceFromIdentifier(identifier);
		}
		if (!this.pathService.readFile) {
			throw new Error('Workspace configuration reading is unavailable');
		}
		const configPath = identifier.configPath.fsPath;
		const source = await this.pathService.readFile(configPath);
		const configuredFolders = parseStoredWorkspaceFolders(parseJsonc(source, configPath), configPath);
		const folders: IWorkspaceFolder[] = [];
		const identities = new Set<string>();
		for (const configured of configuredFolders) {
			const requestedPath = configured.path ?? URI.parse(configured.uri!).fsPath;
			const absolutePath = isAbsolute(requestedPath) ? requestedPath : resolve(dirname(configPath), requestedPath);
			const resolved = await this.pathService.resolvePath(absolutePath);
			if (resolved.kind !== WorkspacePathKind.Directory) {
				throw new Error(`Workspace folder is not a directory: ${requestedPath}`);
			}
			const uri = URI.file(resolved.path);
			const identity = process.platform === 'linux' ? uri.toString() : uri.toString().toLowerCase();
			if (identities.has(identity)) {
				continue;
			}
			identities.add(identity);
			folders.push(Object.freeze({
				id: stableWorkspaceId(uri),
				uri,
				name: configured.name ?? basename(resolved.path),
				index: folders.length,
			}));
		}
		return Object.freeze({
			id: identifier.id,
			folders: Object.freeze(folders),
			configuration: identifier.configPath,
			name: workspaceFromIdentifier(identifier).name,
		});
	}
}
