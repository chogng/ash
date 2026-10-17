import { BrowserContentSearchService } from '../../../../../platform/search/browser/searchService.js';
import type { IContentSearchOptions, IContentSearchQuery, IContentSearchService } from '../../../../../platform/search/common/search.js';
import type { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import type { FileFuzzyQuery, FileSearchDirectory, FileSearchQuery, FileSearchResult, IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { AppServerFileSystemProvider } from '../../../../../platform/agentHost/browser/appServerFileSystemProvider.js';
import type { IFileSystemDirectory } from '../../../../../platform/files/common/fileApi.js';
import type { IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';

/** Adds Session-scoped search to the shared filesystem provider; file routing never uses selection. */
export class SessionFileService extends AppServerFileSystemProvider implements IFileSearchService, IContentSearchService {
	private readonly fileSearch: IFileSearchService;
	private readonly contentSearch: IContentSearchService;
	constructor(
		host: IRendererHost,
		directories: () => readonly IFileSystemDirectory[],
	) {
		const target = <T extends { readonly dirId?: string; }>(params: T): Omit<T, 'dirId'> & { dirId?: string; sessionDirectory?: { sessionId: string; path: string; }; } => {
			if (!params.dirId?.startsWith('session:')) { return params; }
			const { dirId, ...rest } = params;
			return { ...rest, sessionDirectory: sessionDirectoryFor(dirId) };
		};
		super({
			api: host.fs,
			resourceApi: host.resource,
			directories,
			onDidChange: listener => {
				const subscription = host.events.subscribe(event => {
					if (event.method === 'fs/changed') { listener(event.params); }
				});
				return toDisposable(() => subscription.dispose());
			},
		});
		this.fileSearch = host.fileSearch;
		this.contentSearch = new BrowserContentSearchService({
			start: params => host.contentSearch.start(target(params)),
			read: params => host.contentSearch.read(target(params)),
			cancel: params => host.contentSearch.cancel(target(params)),
		});
	}


	public search(folder: IWorkspaceFolder, query: IContentSearchQuery, options?: IContentSearchOptions) {
		return this.contentSearch.search(folder, query, options);
	}

	public glob(directory: FileSearchDirectory, query: FileSearchQuery, signal?: AbortSignal): Promise<FileSearchResult> {
		if (directory.target.type === 'workspace' && directory.target.dirId.startsWith('session:')) {
			return this.fileSearch.glob({ resource: directory.resource, target: { type: 'session', ...sessionDirectoryFor(directory.target.dirId) } }, query, signal);
		}
		return this.fileSearch.glob(directory, query, signal);
	}

	public fuzzy(directory: FileSearchDirectory, query: FileFuzzyQuery, signal?: AbortSignal): Promise<FileSearchResult> {
		if (directory.target.type === 'workspace' && directory.target.dirId.startsWith('session:')) {
			return this.fileSearch.fuzzy({ resource: directory.resource, target: { type: 'session', ...sessionDirectoryFor(directory.target.dirId) } }, query, signal);
		}
		return this.fileSearch.fuzzy(directory, query, signal);
	}
}

function sessionDirectoryFor(dirId: string): { sessionId: string; path: string; } {
	const [sessionId, path] = dirId.slice('session:'.length).split(':').map(decodeURIComponent);
	return { sessionId, path };
}
