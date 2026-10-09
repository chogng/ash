import type { FileSearchDirectory, FileSearchQuery, FileSearchResult, IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AppServerFileSystemProvider } from '../../../../../platform/agentHost/browser/appServerFileSystemProvider.js';
import type { IFileApi } from '../../../../../platform/files/common/fileApi.js';
import type { IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';

/** Selects the owning Session at the transport boundary; shared file/editor state stays in Workbench. */
export class SessionFileService extends AppServerFileSystemProvider implements IFileSearchService {
	private readonly fileSearch: IFileSearchService;
	constructor(
		host: IRendererHost,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		const target = <T extends { readonly dirId?: string; }>(params: T): Omit<T, 'dirId'> & { dirId?: string; sessionDirectory?: { sessionId: string; path: string; }; } => {
			if (!params.dirId?.startsWith('session:')) { return params; }
			const { dirId, ...rest } = params;
			return { ...rest, sessionDirectory: sessionDirectoryFor(dirId) };
		};
		const api: IFileApi = {
			get connectionGeneration() { return host.fs.connectionGeneration; },
			onDidChangeConnection: host.fs.onDidChangeConnection,
			readPathCaseSensitivity: params => host.fs.readPathCaseSensitivity(target(params)),
			writeFileElevated: (params, signal) => host.fs.writeFileElevated(target(params), signal),
			getMetadata: params => host.fs.getMetadata(target(params)),
			readDirectory: params => host.fs.readDirectory(target(params)),
			readFile: params => host.fs.readFile(target(params)),
			readBinaryFile: params => host.fs.readBinaryFile(target(params)),
			writeFile: params => host.fs.writeFile(target(params)),
			writeBinaryFile: params => host.fs.writeBinaryFile(target(params)),
			createFile: params => host.fs.createFile(target(params)),
			createDirectory: params => host.fs.createDirectory(target(params)),
			copy: params => {
				if (params.sourceDirId?.startsWith('session:') || params.targetDirId?.startsWith('session:')) {
					if (params.sourceDirId !== params.targetDirId) { throw new Error('Copying between Session directories is not supported.'); }
					const selected = target({ dirId: params.sourceDirId });
					return host.fs.copy({ source: params.source, target: params.target, sessionDirectory: selected.sessionDirectory });
				}
				return host.fs.copy(params);
			},
			pasteSystemFiles: params => host.fs.pasteSystemFiles(target(params)),
			rename: params => host.fs.rename(target(params)),
			delete: params => host.fs.delete(target(params)),
		};
		super({
			api,
			resourceApi: host.resource,
			workspaceContextService: workspace,
			onDidChange: listener => {
				const subscription = host.events.subscribe(event => {
					if (event.method === 'fs/changed') { listener(event.params); }
				});
				return toDisposable(() => subscription.dispose());
			},
		});
		this.fileSearch = host.fileSearch;
	}

	public glob(directory: FileSearchDirectory, query: FileSearchQuery, signal?: AbortSignal): Promise<FileSearchResult> {
		if (directory.target.type === 'workspace' && directory.target.dirId.startsWith('session:')) {
			return this.fileSearch.glob({ resource: directory.resource, target: { type: 'session', ...sessionDirectoryFor(directory.target.dirId) } }, query, signal);
		}
		return this.fileSearch.glob(directory, query, signal);
	}
}

function sessionDirectoryFor(dirId: string): { sessionId: string; path: string; } {
	const [sessionId, path] = dirId.slice('session:'.length).split(':').map(decodeURIComponent);
	return { sessionId, path };
}
